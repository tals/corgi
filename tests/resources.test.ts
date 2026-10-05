import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTE, Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, shellJoin, sleep } from "./support";

// The hovered resource row: its background, then its readings' style.
const hover = `\x1b[48;2;${PALETTE.selected}m\x1b[22m`;

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
      this.assertIn(`\x1b[4m\x1b[58:2::${PALETTE.line.replaceAll(";", ":")}m`, resourceRow);
      this.assertIn("\x1b[24;59m", resourceRow);
      this.assertRegex(screen_text(frame, cols, 40)[4], /CPU .*Mem/);
      // Disk throughput stays in the hover card.
      this.assertNotIn("↕", screen_text(frame, cols, 40)[4]);
      this.assertEqual(screen_text(frame, cols, 40)[4][25], "›");
      this.assertNotIn(hover, frame);

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
      this.assertNotIn(hover, viewer.state.data);
      await viewer.input("\x1b[<35;5;5M");
      this.assertNotIn("TOP PROCESSES", viewer.state.data);
      this.assertIn(hover, viewer.state.data);
      // The end chevron belongs to the same hover target; the padding does not.
      await viewer.input("\x1b[<35;26;5M");
      this.assertIn(hover, viewer.state.data);
      await viewer.input("\x1b[<35;27;5M");
      this.assertNotIn(hover, viewer.state.data);
      await viewer.input("\x1b[<35;5;5M");
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

    // A terminal too short for the card must not advertise hover details.
    const quiet = await Viewer.create(this, 120, 20);
    this.assertNotIn("›", screen_text(quiet.state.data, 120, 20)[4]);
    await quiet.input("\x1b[<35;5;5M");
    await quiet.advance(0.6);
    this.assertNotIn(hover, quiet.state.data);
    this.assertNotIn("TOP PROCESSES", quiet.state.data);
    await quiet.close();
  }

  async test_readings_off_removes_the_row_and_stops_sampling() {
    const first = (await this.session()).workspaces[0].id;
    await this.command("pane.create", {
      workspace: first, cwd: this.temp.name, command: "/bin/sleep 300",
    });
    const second = (await this.command("workspace.create", {
      name: "second", cwd: this.temp.name,
    })).workspace;
    await this.until(async () => (await this.session()).resources.sampled_at > 0, 8);
    const preferences = join(this.env.XDG_STATE_HOME!, "corgi/viewer.json");
    writeFileSync(preferences, JSON.stringify({
      onboarding_complete: true, resources: { enabled: false },
    }));
    const viewer = await Viewer.create(this, 120, 40);
    await viewer.request({ op: "workspace", workspace: first });
    // The daemon stops sampling and drops what it had.
    await this.until(async () => {
      await viewer.poll();
      const resources = (await this.session()).resources;
      return resources.sampled_at === 0 && resources.workspaces.length === 0;
    }, 5);
    const rows = screen_text(viewer.state.data, 120, 40);
    // Two rows per workspace: the second workspace's name follows the first's status.
    this.assertIn("second", rows[4]);
    for (const row of rows.slice(0, 12)) this.assertFalse(/CPU .*Mem/.test(row), row);
    await viewer.input("\x1b[<0;5;6M");
    await viewer.input("\x1b[<0;5;6m");
    this.assertEqual(viewer.state.workspace, second);
    await viewer.close();

    // Sampling stays stopped after the last viewer detaches.
    await sleep(2.5);
    this.assertEqual((await this.session()).resources.sampled_at, 0);

    writeFileSync(preferences, JSON.stringify({ onboarding_complete: true }));
    const shown = await Viewer.create(this, 120, 40);
    await this.until(async () => {
      await shown.poll();
      return (await this.session()).resources.sampled_at > 0;
    }, 8);
    await shown.close();
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
    this.assertRegex(rows[4], /CPU .*Mem/);
    this.assertRegex(rows[7], /CPU .*Mem/);
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
      this.assertIn(hover, viewer.state.data);
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
    this.assertNotIn(hover, viewer.state.data);
    await viewer.poll();
    await this.until(async () => (await this.session()).resources.interval_ms === 2000, 5);
    // Menu aim: a diagonal swing toward the card crosses the next workspace's
    // rows, including its resource row, without closing or switching the card.
    await viewer.input("\x1b[<35;5;5M");
    await viewer.advance(0.6);
    await this.until(async () => (await viewer.poll()).data.includes("TOP PROCESSES"));
    for (const [column, row] of [[9, 8], [15, 11], [21, 14], [41, 19]]) {
      await viewer.input(`\x1b[<35;${column};${row}M`);
      this.assertIn("TOP PROCESSES", viewer.state.data);
      this.assertNotIn("quiet / resources", viewer.state.data);
    }
    // Resting short of the card hands the hover to what is underneath.
    await viewer.input("\x1b[<35;5;5M");
    await viewer.input("\x1b[<35;9;8M");
    this.assertIn("TOP PROCESSES", viewer.state.data);
    await viewer.advance(0.35);
    this.assertNotIn("TOP PROCESSES", viewer.state.data);
    await viewer.advance(0.6);
    this.assertIn("quiet / resources", viewer.state.data);
    await viewer.input("\x1b[<35;118;38M");
    this.assertNotIn("TOP PROCESSES", viewer.state.data);
    await this.command("pane.close", { target: pane });
    await this.until(async () => !(await this.session()).resources.workspaces.some((w: any) => w.processes.some((p: any) => p.pid === pid)), 8);
  }
}
registerCase("Resources", Resources);
