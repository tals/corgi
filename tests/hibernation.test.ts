import { Runtime, EXE, Viewer, layout_tree, screen_text } from "./runtime";
import { registerCase, run, quote } from "./support";
import { write_ordinary_agent } from "./provider_sim";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

class Hibernation extends Runtime {
  async idle(pane: number) {
    await this.until(async () => (await this.rpc({ op: "pane.idle" })).panes.some((p: any) => p.pane === pane));
  }
  async shell(workspace = 1) {
    const result = await this.command("pane.create", { workspace, cwd: this.temp.name });
    await this.idle(result.pane);
    return result.pane;
  }
  async pane(id: number) {
    return (await this.session()).panes.find((p: any) => p.id === id);
  }
  async history(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "history" })).text;
  }
  reload() {
    return this.rpc({ op: "server.reload", executable: EXE });
  }
  async cli(...args: string[]) {
    const result = await run([EXE, ...args, "--json"], { env: this.env });
    this.assertEqual(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  async test_hibernate_keeps_focus_in_two_viewers_until_reentry_or_explicit_resume() {
    const first = await this.shell(),
      second = await this.shell();
    const one = await Viewer.create(this),
      two = await Viewer.create(this);
    await one.focus(first);
    await two.focus(first);
    const pid = (await this.pane(first)).pid;
    await this.cli("pane", "hibernate", String(first));
    await one.poll();
    await two.poll();
    await one.poll();
    await two.poll();
    this.assertEqual([one.state.pane, two.state.pane], [first, first]);
    this.assertEqual([(await this.pane(first)).dormant, (await this.pane(first)).pid], [true, -1]);
    await this.until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await one.focus(second);
    await one.focus(first);
    await this.idle(first);
    this.assertEqual((await this.pane(first)).dormant, false);
    await two.poll();
    await one.action("hibernate");
    await two.poll();
    await two.poll();
    this.assertEqual((await this.pane(first)).dormant, true);
    await two.action("wake");
    await this.idle(first);
    this.assertEqual((await this.pane(first)).dormant, false);
    await this.cli("pane", "wake", String(first));
  }
  async test_archive_survives_reload_and_restart_and_only_selected_pane_wakes() {
    const first = await this.shell();
    const second = (await this.command("pane.split", { target: first, direction: "right" })).pane;
    await this.idle(second);
    const other = await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    await this.idle(other.pane);
    const layout = layout_tree((await this.session()).workspaces[0]);
    await this.command("pane.send", { target: first, text: "printf 'KEPT_OUTPUT\\n'", enter: true });
    await this.until(async () => (await this.history(first)).includes("KEPT_OUTPUT"));
    await this.idle(first);
    await this.cli("workspace", "archive", "1");
    await this.reload();
    this.assertEqual((await this.pane(first)).dormant, true);
    await this.restart_runtime();
    const recovered = await this.session();
    this.assertEqual(recovered.workspaces[0].archived, true);
    this.assertEqual(layout_tree(recovered.workspaces[0]), layout);
    this.assertEqual(
      [first, second].map(id => recovered.panes.find((p: any) => p.id === id).pid),
      [-1, -1],
    );
    this.assertIn("KEPT_OUTPUT", await this.history(first));
    await this.cli("workspace", "unarchive", "1");
    this.assertEqual((await this.session()).workspaces[0].archived, false);
    this.assertEqual([(await this.pane(first)).dormant, (await this.pane(second)).dormant], [true, true]);
    await this.cli("workspace", "archive", "1");
    const viewer = await Viewer.create(this);
    this.assertEqual(viewer.state.workspace, other.workspace);
    this.assertIn("▸ 1 archived", screen_text(viewer.state.data, 100, 30).join("\n"));
    await viewer.action("choose-workspace");
    await viewer.input("\x1b[B\r");
    this.assertIn("▾ 1 archived", screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertEqual((await this.pane(first)).dormant, true);
    this.assertEqual((await this.pane(second)).dormant, true);
    await viewer.input("\x1b[B\r");
    await viewer.poll();
    await this.idle(viewer.state.pane);
    const selected = viewer.state.pane,
      sleeping = selected === first ? second : first;
    this.assertEqual((await this.session()).workspaces[0].archived, false);
    this.assertEqual((await this.pane(sleeping)).dormant, true);
  }
  async test_batch_hibernates_busy_and_idle_panes_and_unknown_program_wakes_as_shell() {
    const first = await this.shell();
    const busy = (
      await this.command("pane.create", {
        workspace: 1,
        cwd: this.temp.name,
        command: "printf 'BUSY_READY\\n'; exec sleep 120",
      })
    ).pane;
    await this.until(async () => (await this.history(busy)).includes("BUSY_READY"));
    await this.command("pane.hibernate", { targets: [first, busy] });
    for (const id of [first, busy])
      this.assertEqual([(await this.pane(id)).pid, (await this.pane(id)).dormant], [-1, true]);
    await this.command("pane.wake", { target: busy });
    await this.idle(busy);
    this.assertIn("BUSY_READY", await this.history(busy));
  }
  async test_archived_sidebar_expands_scrolls_and_opens_with_the_mouse() {
    const first = await this.shell();
    await this.command("workspace.edit", { target: 1, name: "Archived 0" });
    const active = await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    await this.command("workspace.archive", { target: 1 });
    const panes = [first];
    for (let i = 1; i < 8; i++) {
      const ws = await this.command("workspace.create", { name: `Archived ${i}`, cwd: this.temp.name });
      panes.push(ws.pane);
      await this.command("workspace.archive", { target: ws.workspace });
    }
    const viewer = await Viewer.create(this);
    const text = () => screen_text(viewer.state.data, 100, 30);
    this.assertEqual(viewer.state.workspace, active.workspace);
    this.assertIn("▸ 8 archived", text().join("\n"));
    this.assertNotIn("Archived 0", text().join("\n"));
    const click = (row: number) => viewer.input(`\x1b[<0;5;${row + 1}M\x1b[<0;5;${row + 1}m`);
    await click(text().findIndex(row => row.includes("▸ 8 archived")));
    this.assertIn("▾ 8 archived", text().join("\n"));
    this.assertIn("Archived 0", text().join("\n"));
    for (const id of panes) this.assertEqual((await this.pane(id)).dormant, true);
    const header = text().findIndex(row => row.includes("▾ 8 archived"));
    for (let i = 0; i < 8; i++) await viewer.input(`\x1b[<65;5;${header + 2}M`);
    this.assertIn("Archived 7", text().join("\n"));
    this.assertNotIn("Archived 0", text().join("\n"));
    await click(text().findIndex(row => row.includes("Archived 7")));
    await this.idle(panes[7]);
    this.assertEqual(viewer.state.pane, panes[7]);
    for (const id of panes.slice(0, 7)) this.assertEqual((await this.pane(id)).dormant, true);
    const fresh = await Viewer.create(this);
    this.assertIn("▸ 7 archived", screen_text(fresh.state.data, 100, 30).join("\n"));
  }
  async test_agent_resumes_same_conversation_in_same_pane() {
    this.env.CORGI_CLAUDE_BIN = join(this.temp.name, "claude");
    const id = await this.ordinary_agent("claude", true);
    await this.until(async () => (await this.pane(id)).agent?.session === "ordinary-claude");
    await this.command("pane.send", { target: id, text: "work", enter: true });
    await this.until(async () => (await this.pane(id)).agent.state === "working");
    const before = await this.pane(id);
    await this.command("pane.hibernate", { targets: [id] });
    this.assertEqual((await this.pane(id)).dormant, true);
    await this.command("pane.wake", { target: id });
    await this.until(async () => {
      const p = await this.pane(id);
      return !p.dormant && p.pid > 0 && p.agent?.session === "ordinary-claude" && !p.restoring;
    });
    this.assertNotEqual((await this.pane(id)).pid, before.pid);
  }
  async test_closing_last_active_workspace_keeps_archives_asleep_across_restart() {
    const id = await this.shell();
    const other = await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    await this.command("workspace.archive", { target: 1 });
    const viewer = await Viewer.create(this);
    await viewer.focus(other.pane);
    await viewer.action("close-workspace");
    this.assertIn("Create workspace", screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertEqual((await this.pane(id)).dormant, true);
    await this.reload();
    await this.restart_runtime();
    const reopened = await Viewer.create(this);
    this.assertIn("Create workspace", screen_text(reopened.state.data, 100, 30).join("\n"));
    this.assertIn("1 archived", screen_text(reopened.state.data, 100, 30).join("\n"));
    this.assertEqual(
      (await this.session()).workspaces.map((w: any) => [w.id, w.archived]),
      [[1, true]],
    );
    this.assertEqual((await this.pane(id)).dormant, true);
    await reopened.action("toggle-archived-workspaces");
    await reopened.focus(id);
    await this.idle(id);
    this.assertEqual((await this.session()).workspaces[0].archived, false);
  }
  async test_archived_agents_wait_for_enter_even_after_cold_recovery() {
    this.env.SHELL = "/bin/bash";
    this.env.CORGI_CLAUDE_BIN = join(this.temp.name, "claude");
    this.env.PATH = this.temp.name + ":" + this.env.PATH;
    const id = await this.ordinary_agent("claude", true);
    await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    await this.command("pane.send", { target: id, text: "work", enter: true });
    await this.until(async () => (await this.pane(id)).agent.state === "working");
    await this.command("workspace.archive", { target: 1 });
    this.assertEqual((await this.session()).workspaces[0].archive_summary.running, 1);
    await this.restart_runtime();
    const viewer = await Viewer.create(this);
    await viewer.focus(id);
    await this.idle(id);
    await this.until(async () => {
      await viewer.poll();
      return screen_text(viewer.state.data, 100, 30).join("\n").includes("claude --resume ordinary-claude");
    });
    this.assertEqual((await this.pane(id)).agent.state, "unknown");
    this.assertEqual((await this.session()).workspaces[0].archived, false);
    await this.reload();
    await this.idle(id);
    await this.restart_runtime();
    const command = "claude --resume ordinary-claude";
    const previous = (await this.history(id)).split(command).length;
    await this.command("pane.wake", { target: id });
    await this.idle(id);
    await this.until(async () => (await this.history(id)).split(command).length > previous);
    await this.command("pane.send", { target: id, text: "", enter: true });
    await this.until(
      async () =>
        (await this.pane(id)).agent.state === "idle" && (await this.pane(id)).agent.session === "ordinary-claude",
    );
    // Running the staged command consumes manual restore, even across another restart.
    await this.restart_runtime();
    const active = await Viewer.create(this);
    await active.focus(id);
    await this.until(async () => (await this.pane(id)).agent.state === "idle");
    await this.command("pane.hibernate", { targets: [id] });
    await active.poll();
    this.assertEqual((await this.pane(id)).dormant, true);
    await active.focus((await this.session()).panes.find((p: any) => p.id !== id).id);
    await active.focus(id);
    await this.until(async () => (await this.pane(id)).agent.state === "idle");
    this.assertEqual((await this.pane(id)).agent.session, "ordinary-claude");
  }
  async test_archiving_keeps_a_manually_started_program_command_without_running_it() {
    this.env.SHELL = "/bin/bash";
    await this.restart_runtime();
    const id = await this.shell();
    await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    const script = join(this.temp.name, "server with spaces.ts");
    const launches = join(this.temp.name, "launches");
    await Bun.write(
      script,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(launches)}, "started\\n"); setInterval(() => {}, 1000);`,
    );
    await this.command("pane.send", { target: id, text: "bun " + JSON.stringify(script), enter: true });
    await this.until(
      async () => (await Bun.file(launches).exists()) && (await Bun.file(launches).text()) === "started\n",
    );
    await this.command("workspace.archive", { target: 1 });
    this.assertEqual(
      (await this.session()).workspaces[0].archive_summary.programs.map((p: any) => [p.count, p.name, p.brand]),
      [[1, "server with spaces", "bun"]],
    );
    await this.restart_runtime();
    await this.command("pane.wake", { target: id });
    await this.idle(id);
    await this.until(async () => (await this.history(id)).includes("'" + script + "'"));
    this.assertEqual(await Bun.file(launches).text(), "started\n");
    await this.command("workspace.archive", { target: 1 });
    await this.restart_runtime();
    const previous = (await this.history(id)).split("'" + script + "'").length;
    await this.command("pane.wake", { target: id });
    await this.idle(id);
    await this.until(async () => (await this.history(id)).split("'" + script + "'").length > previous);
    this.assertEqual(await Bun.file(launches).text(), "started\n");
    await this.command("pane.send", { target: id, text: "", enter: true });
    await this.until(async () => (await Bun.file(launches).text()) === "started\nstarted\n");
  }
  /** A shell pane running a program that counts its starts, archived and woken with it typed at the prompt. */
  async archived_program() {
    this.env.SHELL = "/bin/bash";
    await this.restart_runtime();
    const id = await this.shell();
    await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    const script = join(this.temp.name, "dev server.ts");
    const launches = join(this.temp.name, "launches");
    await Bun.write(
      script,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(launches)}, "started\\n"); setInterval(() => {}, 1000);`,
    );
    await this.command("pane.send", { target: id, text: "bun " + JSON.stringify(script), enter: true });
    await this.until(
      async () => (await Bun.file(launches).exists()) && (await Bun.file(launches).text()) === "started\n",
    );
    await this.command("workspace.archive", { target: 1 });
    await this.command("pane.wake", { target: id });
    await this.idle(id);
    await this.until(async () => (await this.history(id)).includes("'" + script + "'"));
    return { id, launches };
  }
  async test_an_agent_started_after_an_archived_program_resumes_as_itself() {
    this.env.CORGI_CLAUDE_BIN = join(this.temp.name, "claude");
    write_ordinary_agent(join(this.temp.name, "claude"));
    mkdirSync(this.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    const { id, launches } = await this.archived_program();
    await this.command("pane.input", { target: id, data: `\x15PATH=${quote(this.temp.name)}:$PATH claude\r` });
    await this.until(async () => (await this.pane(id)).agent?.session === "ordinary-claude");
    await this.command("pane.hibernate", { targets: [id] });
    await this.restart_runtime();
    this.assertEqual((await this.pane(id)).restoring, "claude --resume ordinary-claude");
    await this.command("pane.wake", { target: id });
    await this.until(async () => {
      const p = await this.pane(id);
      return !p.dormant && p.agent?.state === "idle" && p.agent.session === "ordinary-claude";
    });
    this.assertEqual(await Bun.file(launches).text(), "started\n");
  }
  async test_another_program_after_an_archived_one_drops_its_command() {
    const { id, launches } = await this.archived_program();
    await this.command("pane.input", { target: id, data: "\x15sleep 60\r" });
    await this.until(async () => (await this.pane(id)).command === "sleep");
    await this.command("pane.hibernate", { targets: [id] });
    this.assertEqual((await this.pane(id)).restoring, "");
    await this.command("pane.wake", { target: id });
    await this.idle(id);
    this.assertEqual(await Bun.file(launches).text(), "started\n");
  }
  async test_archiving_a_program_too_long_to_save_still_recovers() {
    const id = await this.shell();
    await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    const command = `bun -e "setInterval(() => {}, 1000)" ${"x".repeat(3000)}`;
    await this.command("pane.send", { target: id, text: command, enter: true });
    await this.until(async () => (await this.pane(id)).command === "bun");
    await this.command("workspace.archive", { target: 1 });
    await this.restart_runtime();
    this.assertEqual([(await this.pane(id)).dormant, (await this.pane(id)).restoring], [true, ""]);
  }
  async test_fresh_agent_without_session_restarts_after_hibernation_and_recovery() {
    this.env.CORGI_CLAUDE_BIN = join(this.temp.name, "claude");
    const id = await this.ordinary_agent("claude", true, true);
    await this.until(async () => (await this.pane(id)).agent.state === "initializing");
    this.assertEqual((await this.pane(id)).agent.session, "");
    await this.command("pane.hibernate", { targets: [id] });
    await this.restart_runtime();
    this.assertEqual((await this.pane(id)).dormant, true);
    await this.command("pane.wake", { target: id });
    await this.until(async () => !(await this.pane(id)).dormant && (await this.pane(id)).pid > 0);
    await this.command("pane.send", { target: id, text: "ready", enter: true });
    await this.until(async () => (await this.pane(id)).agent.session === "ordinary-claude");
  }
  async test_archive_review_lists_a_server_and_cancel_keeps_it_running() {
    const first = await this.shell();
    const other = await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    await this.idle(other.pane);
    const script = join(this.temp.name, "server.ts");
    await Bun.write(
      script,
      'const server = Bun.serve({port: 0, fetch: () => new Response("ok")}); console.log("http://localhost:" + server.port);',
    );
    await this.command("pane.send", { target: first, text: "bun " + JSON.stringify(script), enter: true });
    await this.until(async () => /http:\/\/localhost:\d+/.test(await this.history(first)));
    let preview: any;
    await this.until(async () => {
      preview = (await this.rpc({ op: "workspace.archive.preview", target: 1 })).preview;
      return preview.links.length > 0;
    });
    this.assertEqual(preview.processes_available, true);
    this.assertEqual(
      preview.processes.map((p: any) => [p.name, p.brand]),
      [["server", "bun"]],
    );
    this.assertEqual((await fetch(preview.links[0])).status, 200);
    const viewer = await Viewer.create(this);
    await viewer.focus(first);
    const show = async () => {
      await viewer.action("edit-workspace");
      await viewer.input("a");
      await this.until(async () => {
        await viewer.poll();
        return screen_text(viewer.state.data, 100, 30).join("\n").includes("Processes");
      });
    };
    await show();
    this.assertIn(preview.links[0], screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertEqual((await this.pane(first)).dormant, false);
    await viewer.input("\r");
    this.assertEqual((await fetch(preview.links[0])).status, 200);
    await show();
    await viewer.input("a");
    await this.until(async () => (await this.pane(first)).dormant);
    this.assertEqual((await this.session()).workspaces[0].archived, true);
    this.assertEqual(viewer.state.workspace, other.workspace);
    await this.until(async () => {
      try {
        await fetch(preview.links[0]);
        return false;
      } catch {
        return true;
      }
    });
  }
  async test_archive_agent_preview_keeps_unread_and_focus_until_keyboard_or_mouse_entry() {
    const shell = await this.shell();
    const id = await this.ordinary_agent("claude", true);
    await this.command("workspace.create", { name: "other", cwd: this.temp.name });
    const viewer = this.client!;
    await viewer.focus(shell);
    await viewer.request({ op: "size", cols: 100, rows: 30 });
    await this.command("pane.rename", { target: id, name: "Review migration" });
    await this.command("pane.send", { target: id, text: "work", enter: true });
    await this.until(async () => (await this.pane(id)).agent.state === "working");
    await this.command("pane.send", { target: id, text: "stop", enter: true });
    await this.until(async () => BigInt((await this.pane(id)).agent.observation.completed) > 0n);
    const show = async () => {
      await viewer.action("archive-workspace");
      await this.until(async () => {
        await viewer.poll();
        return screen_text(viewer.state.data, 100, 30).some(row => row.includes("Agents (1)"));
      });
    };
    await show();
    const buttonsRow = screen_text(viewer.state.data, 100, 30).findIndex(row => row.includes("Archive workspace"));
    const agentRow = screen_text(viewer.state.data, 100, 30).findIndex(row => row.includes("Agents (1)")) + 2;
    await viewer.input(`\x1b[<35;30;${agentRow}M`);
    await viewer.poll();
    this.assertIn("↓ Review migration ↓", screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertEqual(viewer.state.pane, shell);
    await viewer.input("\x1b[<35;1;1M");
    await viewer.poll();
    this.assertNotIn("↓ Review migration ↓", screen_text(viewer.state.data, 100, 30).join("\n"));
    await viewer.input("\x1b[B");
    await viewer.poll();
    this.assertEqual(
      screen_text(viewer.state.data, 100, 30).findIndex(row => row.includes("Archive workspace")),
      buttonsRow,
    );
    this.assertIn("↓ Review migration ↓", screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertEqual(viewer.state.pane, shell);
    const observation = (await this.pane(id)).agent.observation;
    this.assertEqual(BigInt(observation.read) < BigInt(observation.completed), true);
    this.assertEqual((await this.pane(id)).dormant, false);
    await viewer.input("\r");
    this.assertEqual(viewer.state.pane, id);
    this.assertNotIn("Archive workspace", screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertEqual((await this.session()).workspaces[0].archived, false);
    await viewer.focus(shell);
    await show();
    const rows = screen_text(viewer.state.data, 100, 30);
    const y = rows.findIndex(row => row.includes("Agents (1)")) + 2;
    await viewer.input(`\x1b[<0;30;${y}M\x1b[<0;30;${y}m`);
    this.assertEqual(viewer.state.pane, id);
    this.assertNotIn("Archive workspace", screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertEqual((await this.session()).workspaces[0].archived, false);
  }
  async test_starting_headless_work_reveals_archived_workspace_and_archiving_keeps_a_dormant_pane() {
    const first = await this.shell();
    const other = await this.command("workspace.create", { name: "active", cwd: this.temp.name });
    await this.idle(other.pane);
    await this.command("workspace.archive", { target: 1 });
    const headless = await this.rpc({
      op: "headless.start",
      provider: "codex",
      prompt: "test/init",
      cwd: this.temp.name,
      workspace: 1,
    });
    this.assertEqual((await this.session()).workspaces[0].archived, false);
    this.assertEqual((await this.pane(first)).dormant, true);
    await this.command("workspace.archive", { target: 1 });
    const archived = await this.session();
    this.assertEqual(archived.workspaces[0].archived, true);
    this.assertEqual(archived.headless_sessions.length, 0);
    const recovered = archived.panes.find((p: any) => p.workspace === 1 && p.id !== first);
    this.assertEqual(recovered.dormant, true);
    this.assertEqual(recovered.agent.provider, "codex");
    await this.restart_runtime();
    this.assertEqual((await this.pane(recovered.id)).dormant, true);
  }
}
registerCase("Hibernation", Hibernation, { inherited: false });
