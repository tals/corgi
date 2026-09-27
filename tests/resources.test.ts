import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, shellJoin } from "./support";

class Resources extends Runtime {
  async test_process_churn_keeps_established_workspace_totals() {
    const workspace = (await this.session()).workspaces[0].id;
    const trigger = join(this.temp.name, "spawn-children");
    const script = join(this.temp.name, "churn.ts");
    writeFileSync(script, `
      import { existsSync } from "node:fs";
      setInterval(() => {
        if (existsSync(${JSON.stringify(trigger)})) {
          const child = Bun.spawn(["/bin/sleep", "0.9"], {
            stdin: "ignore", stdout: "ignore", stderr: "ignore",
          });
          void child.exited;
        }
      }, 400);
    `);
    await this.command("pane.create", {
      workspace, cwd: this.temp.name, command: shellJoin([process.execPath, script]),
    });
    await this.until(async () => {
      const work = (await this.session()).resources.workspaces.find((w: any) => w.id === workspace);
      return work?.count > 0 && work.cpu != null;
    }, 8);
    writeFileSync(trigger, "go");
    let lastSample = 0, samples = 0, sawNewProcess = false;
    await this.until(async () => {
      const snapshot = (await this.session()).resources;
      if (snapshot.sampled_at === lastSample) return false;
      lastSample = snapshot.sampled_at;
      const work = snapshot.workspaces.find((w: any) => w.id === workspace);
      this.assertIsNotNone(work.cpu);
      this.assertIsNotNone(work.read);
      this.assertIsNotNone(work.written);
      this.assertIsNotNone(work.memory);
      sawNewProcess ||= work.processes.some((p: any) => p.name === "sleep" && p.cpu == null);
      return ++samples >= 5 && sawNewProcess;
    }, 14);
  }

  async test_workspace_clicks_and_separators_preserve_resource_hover() {
    const first = (await this.session()).workspaces[0].id;
    await this.command("pane.create", {
      workspace: first, cwd: this.temp.name, command: "/bin/sleep 300",
    });
    const second = (await this.command("workspace.create", {
      name: "second", cwd: this.temp.name,
    })).workspace;
    await this.until(async () => {
      const workspaces = (await this.session()).resources.workspaces;
      const work = workspaces.find((w: any) => w.id === first);
      return work?.memory > 0 && work.cpu != null && work.read != null &&
        work.written != null && workspaces.some((w: any) => w.id === second && w.cpu != null);
    }, 8);
    const click = async (viewer: Viewer, column: number, row: number) => {
      await viewer.input(`\x1b[<0;${column};${row}M`);
      await viewer.input(`\x1b[<0;${column};${row}m`);
    };

    for (const cols of [120, 100, 88]) {
      const viewer = await Viewer.create(this, cols, 40);
      await viewer.request({ op: "workspace", workspace: first });
      const frame = viewer.state.data;
      const resourceStart = frame.indexOf("\x1b[5;2H", frame.indexOf("workspaces"));
      this.assertGreaterEqual(resourceStart, 0);
      const resourceRow = frame.slice(resourceStart, frame.indexOf("\x1b[6;1H", resourceStart));
      this.assertIn("\x1b[4;58:2::65:70:77m", resourceRow);
      this.assertIn("\x1b[24;59m", resourceRow);
      this.assertRegex(screen_text(frame, cols, 40)[4], /C .*M .*I /);

      // Every workspace row selects, including the previously inert third row.
      for (const row of [6, 7, 8]) {
        await click(viewer, 5, row);
        this.assertEqual(viewer.state.workspace, second);
        await click(viewer, 5, 3);
        this.assertEqual(viewer.state.workspace, first);
      }

      // Hover targets and the half-second delay are unchanged.
      await viewer.input("\x1b[<35;5;4M");
      await viewer.advance(0.6);
      this.assertNotIn("TOP PROCESSES", viewer.state.data);
      await viewer.input("\x1b[<35;5;5M");
      this.assertNotIn("TOP PROCESSES", viewer.state.data);
      await viewer.advance(0.6);
      this.assertIn("TOP PROCESSES", viewer.state.data);

      // At 100/88 columns, the popup covers this part of the second title.
      await click(viewer, 20, 6);
      this.assertEqual(viewer.state.workspace, second);
      this.assertNotIn("TOP PROCESSES", viewer.state.data);
      await click(viewer, 5, 3);
      await viewer.input("\x1b[<35;5;5M");
      await viewer.advance(0.6);
      this.assertIn("TOP PROCESSES", viewer.state.data);
      await click(viewer, 20, 8);
      this.assertEqual(viewer.state.workspace, second);
      await viewer.advance(1);
      this.assertNotIn("TOP PROCESSES", viewer.state.data);
      await viewer.input("\x1b[<35;6;8M");
      await viewer.advance(0.6);
      this.assertIn("TOP PROCESSES", viewer.state.data);

      // Sorting remains owned by the popup outside the sidebar.
      await click(viewer, cols === 120 ? 88 : cols - 23, 22);
      this.assertIn("TOP PROCESSES", viewer.state.data);
      this.assertEqual(viewer.state.workspace, second);
      await viewer.close();
    }
  }

  async test_native_agent_process_is_attributed_without_a_pane() {
    const workspace = (await this.session()).workspaces[0].id;
    await this.rpc({ op: "native.start", provider: "codex", cwd: this.temp.name });
    let work: any;
    await this.until(async () => {
      work = (await this.session()).resources.workspaces.find((w: any) => w.id === workspace);
      return work?.processes.some((p: any) => p.provider === "codex");
    }, 8);
    const agent = work.processes.find((p: any) => p.provider === "codex");
    this.assertEqual(agent.provider, "codex");
    this.assertTrue(agent.memory > 0);
  }

  async test_native_sampling_workspace_isolation_and_hover() {
    const workspace = (await this.session()).workspaces[0].id;
    const script = join(this.temp.name, "resource-fixture.ts");
    const pidFile = join(this.temp.name, "resource.pid");
    writeFileSync(script, `
      import { writeFileSync, appendFileSync } from "node:fs";
      const memory = new Uint8Array(32 * 1024 * 1024).fill(7);
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {
        const until = performance.now() + 10;
        while (performance.now() < until) memory[0] = (memory[0] + 1) & 255;
        appendFileSync(${JSON.stringify(join(this.temp.name, "io.dat"))}, memory.subarray(0, 32768));
      }, 100);
    `);
    const pane = (await this.command("pane.create", {
      workspace, cwd: this.temp.name,
      command: shellJoin([process.execPath, script]),
    })).pane;
    const other = (await this.command("workspace.create", {
      name: "quiet", cwd: this.temp.name,
    })).workspace;
    let sample: any;
    await this.until(async () => {
      const snapshot = await this.session();
      sample = snapshot.resources;
      const work = sample.workspaces.find((w: any) => w.id === workspace);
      return work?.cpu > 3 && work?.memory > 16 * 1024 * 1024;
    }, 12);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const work = sample.workspaces.find((w: any) => w.id === workspace);
    const sampled = work.processes.find((p: any) => p.pid === pid);
    this.assertTrue(sampled);
    this.assertTrue(sampled.cpu > 3 && sampled.cpu < 50);
    this.assertFalse(sample.workspaces.find((w: any) => w.id === other)?.processes.some((p: any) => p.pid === pid));
    this.assertTrue(work.history.length > 1);
    this.assertFalse(work.cpu_pressure);

    const viewer = await Viewer.create(this, 120, 40);
    const second = await Viewer.create(this, 120, 40);
    let frame = (await viewer.poll()).data;
    const rows = screen_text(frame, 120, 40);
    this.assertRegex(rows[4], /C .*M .*I /);
    this.assertRegex(rows[7], /C .*M .*I /);
    await viewer.input("\x1b[<35;5;5M");
    this.assertNotIn("TOP PROCESSES", viewer.state.data);
    await viewer.advance(0.6);
    await this.until(async () => {
      frame = (await viewer.poll()).data;
      return frame.includes("TOP PROCESSES") && frame.includes(String(pid));
    });
    for (const label of ["PID", "PROCESS", "R MB/s", "W MB/s", "memory", "disk I/O"])
      this.assertIn(label, frame);
    this.assertNotIn("ACTIVITY", frame);
    this.assertNotIn("TOP PROCESSES", (await second.poll()).data);
    this.assertNotIn("--", frame);
    this.assertNotIn("100% =", frame);
    this.assertNotIn("process-name hint /", frame);
    this.assertNotIn("Running JavaScript code", frame);
    this.assertNotIn("Activity not known", frame);
    this.assertIn("* Claude Code   † Codex", frame);
    // Cross the padding and divider, including diagonal movement, instead of
    // teleporting from the trigger directly into the card.
    for (const [column, row] of [[26, 5], [27, 6], [28, 7], [29, 8], [70, 12]]) {
      await viewer.input(`\x1b[<35;${column};${row}M`);
      this.assertIn("TOP PROCESSES", viewer.state.data);
    }
    await viewer.input("\x1b[<0;88;19M");
    await viewer.input("\x1b[<0;88;19m");
    this.assertIn("TOP PROCESSES", viewer.state.data);
    this.assertEqual(viewer.state.pane, pane);
    await this.until(async () => (await this.session()).resources.interval_ms === 1000, 5);
    writeFileSync("/tmp/corgi-resource-screen.ansi", viewer.state.data);
    writeFileSync("/tmp/corgi-resource-screen.txt", screen_text(viewer.state.data, 120, 40).join("\n"));
    await viewer.input("\x1b[<35;118;38M");
    this.assertNotIn("TOP PROCESSES", viewer.state.data);
    await viewer.poll();
    await this.until(async () => (await this.session()).resources.interval_ms === 2000, 5);
    await this.command("pane.close", { target: pane });
    await this.until(async () => !(await this.session()).resources.workspaces.some((w: any) => w.processes.some((p: any) => p.pid === pid)), 8);
  }
}
registerCase("Resources", Resources);
