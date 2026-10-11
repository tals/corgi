import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { PALETTE, screen_text, layout_tree } from "./runtime";
import { EXE, JsonSocket, quote, registerCase, shellJoin, sleep, writeExecutable } from "./support";

import { CodexObserver, write_codex_terminal } from "./provider_sim";

// A tinted workspace title row: the active workspace, or the one being dragged.
const tinted = `\x1b[0;1;38;2;${PALETTE.strong};48;2;${PALETTE.selected}m`;
// Workspace bars: accent when active, strong when dragged.
const activeBar = `\x1b[0;38;2;${PALETTE.accent};48;2;${PALETTE.selected}m▌`;
const ghostBar = `\x1b[0;38;2;${PALETTE.strong};48;2;${PALETTE.selected}m▌`;

class ViewerScenarios extends Viewers {
  async test_ghostty_setup_toggle_preserves_config_and_routes_tabs() {
    delete this.env.SSH_CONNECTION;
    delete this.env.SSH_TTY;
    this.env.XDG_CONFIG_HOME = join(this.temp.name, ".config");
    const config = join(this.temp.name, "Library/Application Support/com.mitchellh.ghostty/config.ghostty");
    mkdirSync(join(this.temp.name, "Library/Application Support/com.mitchellh.ghostty"), { recursive: true });
    const original = "font-size = 14\nkeybind = cmd+1=goto_tab:1\n";
    writeFileSync(config, original);
    chmodSync(config, 0o640);
    const panes: number[] = [];
    for (let i = 0; i < 9; i++) panes.push(await this.new());
    const viewer = await this.newViewer();
    // The toggle is Command keys under Keymap in Corgi setup, which stays
    // open after Enter; its row shows the current state.
    const ghosttyRow = (data: string) => {
      const screen = screen_text(data, 100, 30);
      const y = screen.findIndex(row => row.includes("Command keys"));
      this.assertTrue(y >= 0, screen);
      return { y, row: screen[y] };
    };
    await viewer.input("\x02i");
    const off = ghosttyRow((await viewer.input("jjjjj")).data).row;
    this.assertTrue(/Command keys\s+○ Off/.test(off), off);
    // Enter opens Keymap on the preset in use; up wraps to Command keys.
    await viewer.input("\rk");
    this.assertIn("enter turn on", screen_text(viewer.state.data, 100, 30).join("\n"));
    await viewer.input("\r");
    await viewer.input("qq");
    const enabled = readFileSync(config, "utf8");
    this.assertEqual(statSync(config).mode & 0o777, 0o640);
    this.assertTrue(enabled.startsWith(original));
    for (let i = 1; i <= 9; i++) {
      this.assertIn(`keybind = cmd+digit_${i}=text:\\x02${i}`, enabled);
      this.assertEqual((await viewer.input(`\x02${i}`)).pane, panes[i - 1]);
    }
    this.assertEqual((await viewer.input("\x02n")).pane, panes[0]);
    this.assertEqual((await viewer.input("\x02p")).pane, panes.at(-1));
    await viewer.input("\x02i");
    const { y, row } = ghosttyRow((await viewer.input("jjjjj")).data);
    this.assertTrue(/Command keys\s+● On/.test(row), row);
    // A click on the option turns it off.
    const x = row.indexOf("Command keys") + 1;
    await viewer.input(`\x1b[<0;${x};${y + 1}M`);
    await viewer.input(`\x1b[<0;${x};${y + 1}m`);
    this.assertEqual(readFileSync(config, "utf8"), original);
    this.assertEqual(statSync(config).mode & 0o777, 0o640);
  }

  async test_agent_hotkeys_follow_complete_workspace_sidebar() {
    const shell = await this.new(),
      home = (await this.session()).workspaces[0].id;
    const agents: number[] = [];
    for (let i = 0; i < 5; i++) agents.push(await this.new());
    agents.push(
      (
        await this.command("pane.split", {
          cwd: this.temp.name,
          command: "sleep 60",
          target: agents.at(-1),
          direction: "right",
        })
      ).pane,
    );
    for (const [i, pane] of agents.entries()) await this.mark_agent(pane, `Agent-${i}`);
    const other = (
      await this.command("workspace.create", {
        name: "Elsewhere",
        cwd: this.temp.name,
      })
    ).workspace;
    const outsider = (
      await this.command("pane.create", {
        workspace: other,
        cwd: this.temp.name,
        command: "sleep 60",
      })
    ).pane;
    await this.mark_agent(outsider, "Outside-agent");
    const a = await this.newViewer(100, 16),
      b = await this.newViewer();
    await a.focus(shell);
    await b.focus(outsider);
    for (const pane of agents) {
      this.assertEqual((await a.input("\x02]")).pane, pane);
      this.assertEqual(a.state.workspace, home);
    }
    const screen = screen_text(a.state.data, 100, 16);
    this.assertTrue(
      screen.some(row => row.slice(0, 27).includes("Agent-5")),
      screen,
    );
    this.assertEqual((await a.input("\x02]")).pane, agents[0]);
    this.assertEqual((await a.input("\x02[")).pane, agents.at(-1));
    this.assertEqual((await b.poll()).pane, outsider);
    await a.input("\x02b");
    this.assertEqual((await a.input("\x02]")).pane, agents[0]);
    await a.focus(shell);
    this.assertEqual((await a.input("\x02\t")).pane, agents[0]);
  }

  async test_agent_scope_menu_only_offers_all_and_current_workspace() {
    const preferences = join(this.env.XDG_STATE_HOME!, "corgi", "viewer.json");
    const first = await this.new();
    await this.mark_agent(first, "Alpha");
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.temp.name,
      })
    ).workspace;
    const outsider = (
      await this.command("pane.create", {
        workspace: other,
        cwd: this.temp.name,
        command: "sleep 60",
      })
    ).pane;
    await this.mark_agent(outsider, "Outside-agent");
    let a = await this.newViewer();
    await a.focus(first);
    const homeWs = (await this.session()).workspaces[0];
    const sidebar = () =>
      screen_text(a.state.data, 100, 30)
        .slice(0, -1)
        .map(row => row.slice(1, 27));
    this.assertFalse(sidebar().some(row => row.includes("Outside-agent")));
    this.assertIn("agents: " + homeWs.name.slice(0, 5), sidebar()[14]);
    await a.input("\x1b[<35;5;15M");
    this.assertNotIn("This workspace", a.state.data);
    await a.input("\x1b[<35;11;15M");
    let rows = sidebar();
    this.assertIn("This workspace", rows[16]);
    this.assertIn("✓", rows[16]);
    this.assertIn("All", rows[17]);
    this.assertIn("2", rows[17]);
    this.assertTrue(rows[18].trim().startsWith("╰"));
    this.assertFalse(rows.slice(15).some(row => row.includes("Other")));
    await a.input("\x1b[<35;60;5M");
    await this.until(async () => !(await a.poll()).data.includes("This workspace"));
    await a.input("\x1b[<35;11;15M");
    await a.input("\x1b[<0;8;18M\x1b[<0;8;18m");
    rows = sidebar();
    this.assertIn("agents: all", rows[14]);
    this.assertTrue(rows[16].startsWith("▾ "));
    this.assertIn("Alpha", rows[17]);
    this.assertTrue(rows[19].startsWith("▾ Other"));
    this.assertTrue(rows[20].startsWith("╰"));
    this.assertIn("Outside-agent", rows[20]);
    await a.input("\x1b[<0;8;20M\x1b[<0;8;20m");
    rows = sidebar();
    this.assertTrue(rows[19].startsWith("▸ Other"));
    this.assertFalse(rows.some(line => line.includes("Outside-agent")));
    await a.input("\x1b[<0;8;20M\x1b[<0;8;20m");
    this.assertIn("Outside-agent", sidebar()[20]);
    await a.input("\x1b[<0;8;21M\x1b[<0;8;21m");
    this.assertEqual(a.state.pane, outsider);
    this.assertEqual(a.state.workspace, other);
    this.assertTrue(sidebar().some(line => line.includes("Alpha")));
    this.assertEqual(JSON.parse(readFileSync(preferences, "utf8")).agents, "all");
    await a.close();
    a = await this.newViewer();
    await a.focus(first);
    this.assertIn("agents: all", sidebar()[14]);
    await a.focus(outsider);
    await a.input("\x1b[<35;11;15M");
    await a.input("\x1b[<0;8;17M\x1b[<0;8;17m");
    rows = sidebar();
    this.assertIn("agents: Other", rows[14]);
    this.assertFalse(rows.some(line => line.includes("Alpha")));
    this.assertTrue(rows.some(line => line.includes("Outside-agent")));
    this.assertEqual(a.state.workspace, other);
    this.assertEqual(JSON.parse(readFileSync(preferences, "utf8")).agents, "workspace");
    await a.focus(first);
    rows = sidebar();
    this.assertIn("agents: " + homeWs.name.slice(0, 5), rows[14]);
    this.assertTrue(rows.some(line => line.includes("Alpha")));
    this.assertFalse(rows.some(line => line.includes("Outside-agent")));
    await a.close();
    a = await this.newViewer();
    await a.focus(outsider);
    this.assertIn("agents: Other", sidebar()[14]);
    this.assertFalse(sidebar().some(line => line.includes("Alpha")));
  }

  async test_agent_sidebar_search_input_mouse_and_stale_targets() {
    const first = await this.new(),
      second = await this.new();
    await this.mark_agent(first, "Alpha");
    await this.mark_agent(second, "Beta");
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.temp.name,
      })
    ).workspace;
    const outsider = (
      await this.command("pane.create", {
        workspace: other,
        cwd: this.temp.name,
        command: "sleep 60",
      })
    ).pane;
    await this.mark_agent(outsider, "Outside-agent");
    const a = await this.newViewer();
    await a.focus(first);
    await a.input("\x02gOutside-agent");
    this.assertIn("No matching agents", a.state.data);
    this.assertEqual((await a.input("\r")).pane, first);
    await a.input("\x15\x1b[200~Beta\r\x02\x1b[201~");
    this.assertIn("↑↓  ↵ jump  Esc back", a.state.data);
    this.assertEqual((await a.input("\r")).pane, second);
    this.assertEqual((await a.input("\x1b[98;5u\x1b[9u")).pane, first);
    await a.input("\x02g\x1b[B");
    this.assertEqual((await a.input("\r")).pane, second);
    await a.input("\x02gAlpha");
    const screen = screen_text(a.state.data, 100, 30);
    const row = screen.findIndex((line, i) => i >= 16 && line.slice(0, 27).includes("Alpha"));
    const col = screen[row].indexOf("Alpha");
    this.assertEqual((await a.input(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)).pane, first);
    await a.input("\x02gBeta");
    await this.command("pane.close", { target: second });
    await a.poll();
    this.assertIn("No matching agents", a.state.data);
    this.assertEqual((await a.input("\r")).pane, first);
    await a.input("\x1b");
    await sleep(0.06);
    await a.poll();
    this.assertNotIn("type to search", a.state.data);
    this.assertEqual((await a.input("\x02\t")).pane, first);
  }

  async test_agent_search_reuses_sidebar_and_restores_it_on_escape() {
    const first = await this.new("printf 'PANE_CONTENT_VISIBLE'; sleep 60");
    await this.mark_agent(first, "Alpha");
    const rest: number[] = [];
    for (let i = 0; i < 5; i++) rest.push(await this.new());
    for (const [i, pane] of rest.entries()) await this.mark_agent(pane, `Agent-${i}`);
    // A resource sample between the two screens would change the sidebar.
    writeFileSync(
      join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"),
      JSON.stringify({ onboarding_complete: true, resources: { enabled: false } }),
    );
    const a = await this.newViewer(100, 24);
    await a.focus(first);
    await this.until(async () => (await a.poll()).data.includes("PANE_CONTENT_VISIBLE"));
    const before = screen_text(a.state.data, 100, 24);
    await a.input("\x02gAgent-4");
    const after = screen_text(a.state.data, 100, 24);
    this.assertEqual(
      before.slice(0, -1).map(row => row.slice(28)),
      after.slice(0, -1).map(row => row.slice(28)),
    );
    this.assertEqual(before.slice(0, 11), after.slice(0, 11));
    this.assertIn("/ Agent-4", after[12]);
    this.assertIn("Agent-4", after[13].slice(0, 27));
    this.assertNotIn(
      "Alpha",
      after
        .slice(13, -1)
        .map(row => row.slice(0, 27))
        .join("\n"),
    );
    this.assertEqual(a.state.pane, first);
    await a.input("\x1b");
    await sleep(0.06);
    await a.poll();
    const restored = screen_text(a.state.data, 100, 24);
    this.assertIn("Alpha", restored[13].slice(0, 27));
    this.assertNotIn("/ Agent-4", restored.join("\n"));
    this.assertEqual(a.state.pane, first);
    await a.input("\x02b\x02g");
    for (const _ of rest) await a.input("\x1b[B");
    this.assertEqual(a.state.pane, first);
    let screen = screen_text(a.state.data, 100, 24);
    this.assertTrue(screen.slice(13, -1).some(row => row.slice(0, 27).includes("Agent-4")));
    this.assertEqual((await a.input("\r")).pane, rest.at(-1));
    await a.request({ op: "size", cols: 40, rows: 18 });
    await a.input("\x02gAlpha");
    this.assertIn("/ ", a.state.data);
    await a.request({ op: "size", cols: 20, rows: 5 });
    await a.input("does-not-match\r");
    this.assertEqual(a.state.pane, rest.at(-1));
    await a.request({ op: "size", cols: 40, rows: 18 });
    await a.input("\x15Alpha");
    this.assertEqual((await a.input("\r")).pane, first);
  }

  async test_last_agent_history_is_per_workspace_and_per_viewer() {
    const first = await this.new(),
      second = await this.new(),
      home = (await this.session()).workspaces[0].id;
    await this.mark_agent(first, "Home-A");
    await this.mark_agent(second, "Home-B");
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.temp.name,
      })
    ).workspace;
    const foreign = [0, 1].map(() => 0);
    for (const i of [0, 1])
      foreign[i] = (
        await this.command("pane.create", {
          workspace: other,
          cwd: this.temp.name,
          command: "sleep 60",
        })
      ).pane;
    for (const [i, pane] of foreign.entries()) await this.mark_agent(pane, `Other-${i}`);
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await a.focus(second);
    await b.focus(first);
    await a.focus(foreign[0]);
    await a.focus(foreign[1]);
    this.assertEqual((await a.input("\x02\t")).pane, foreign[0]);
    await a.request({ op: "workspace", workspace: home });
    this.assertEqual((await a.input("\x02\t")).pane, first);
    this.assertEqual((await a.input("\x02\t")).pane, second);
    this.assertEqual((await b.input("\x02\t")).pane, first);
    await a.input("\x02g");
    await a.request({ op: "workspace", workspace: other });
    this.assertNotIn("type to search", a.state.data);
    this.assertEqual((await a.input("\x02\t")).pane, foreign[1]);
  }

  async test_agent_navigation_includes_native_sessions_and_handles_empty_lists() {
    const first = await this.new();
    await this.mark_agent(first, "Terminal-agent");
    const native = (
      await this.rpc({
        op: "native.start",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    const a = await this.newViewer();
    await a.focus(first);
    await a.input("\x02]");
    this.assertIn(`native session ${native}`, a.state.data);
    await a.input("\x02\t");
    this.assertNotIn(`native session ${native}`, a.state.data);
    await a.input("\x02\t");
    this.assertIn(`native session ${native}`, a.state.data);
    this.assertEqual((await a.input("\x02]")).pane, first);
    const empty = (
      await this.command("workspace.create", {
        name: "Empty",
        cwd: this.temp.name,
      })
    ).workspace;
    await a.poll();
    await a.request({ op: "workspace", workspace: empty });
    await a.input("\x02]\x02[\x02\t");
    this.assertIn("No agents in this workspace", a.state.data);
    await a.input("\x02g");
    this.assertIn("No matching agents", a.state.data);
    await a.request({ op: "size", cols: 20, rows: 5 });
    await a.input("\x1b[A\x1b[B\r");
    this.assertEqual(a.state.workspace, empty);
  }

  async test_pane_menu_names_target_without_stealing_focus() {
    const left = await this.new();
    const right = (
      await this.command("pane.split", {
        cwd: this.temp.name,
        command: "sleep 60",
        target: left,
        direction: "right",
      })
    ).pane;
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(left);
    await b.focus(right);
    await a.input("\x1b[<2;85;5M\x1b[<2;85;5m");
    this.assertEqual(a.state.pane, left);
    this.assertIn("Rename pane", a.state.data);
    this.assertIn("Swap with focused pane", a.state.data);
    await a.input("r");
    await a.input("Logs\r");
    this.assertEqual(a.state.pane, left);
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === right).name, "Logs");
    this.assertEqual((await b.poll()).pane, right);
    await a.input("\x1b[<2;85;5M\x1b[<2;85;5m");
    await a.input("s");
    this.assertEqual(a.state.pane, left);
    const tree = layout_tree((await this.session()).workspaces[0]).split;
    this.assertEqual(tree.first.pane, right);
    this.assertEqual(tree.second.pane, left);
    await a.input("\x1b[<2;35;5M\x1b[<2;35;5m");
    await a.input("C");
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === right).name, "");
  }

  async test_pane_name_survives_reload_and_reopen() {
    const pane = await this.new(),
      a = await this.newViewer();
    await this.mark_agent(pane, "Build");
    await this.run_cli("reload", EXE);
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === pane).name, "Build");
    await this.new();
    await a.focus(pane);
    await a.input("\x1b[<2;35;5M\x1b[<2;35;5m");
    await a.input("x");
    this.assertNotIn(
      pane,
      (await this.session()).panes.map((p: any) => p.id),
    );
    await a.action("undo-close");
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === a.state.pane).name, "Build");
  }

  async test_workspace_drag_order_marker_and_cancellation() {
    await this.new();
    const first = (await this.session()).workspaces[0].id;
    const second = (
      await this.command("workspace.create", {
        name: "Second",
        cwd: this.temp.name,
      })
    ).workspace;
    const third = (
      await this.command("workspace.create", {
        name: "Third",
        cwd: this.temp.name,
      })
    ).workspace;
    const a = await this.newViewer(),
      b = await this.newViewer();
    await b.request({ op: "workspace", workspace: second });
    // Pressing a row switches to it, so switch away mid-drag to drag an inactive one.
    await a.input("\x1b[<0;5;3M");
    await a.request({ op: "workspace", workspace: third });
    await a.input("\x1b[<32;5;11M");
    // The list previews the new order with the dragged row tinted, like agents.
    const preview = screen_text(a.state.data, 100, 30);
    this.assertIn("Second", preview[2]);
    this.assertIn("Third", preview[5]);
    this.assertIn(`\x1b[6;2H${activeBar}`, a.state.data);
    this.assertIn(`\x1b[9;2H${tinted}`, a.state.data);
    for (const row of [9, 10, 11]) this.assertIn(`\x1b[${row};2H${ghostBar}`, a.state.data);
    this.assertIn("\x1b]22;grabbing\x1b\\", a.state.data);
    await a.input("\x1b[<0;5;11m");
    this.assertEqual(
      (await this.session()).workspaces.map((w: any) => w.id),
      [second, third, first],
    );
    this.assertEqual(a.state.workspace, third);
    this.assertEqual((await b.poll()).workspace, second);
    await a.input("\x1b[<0;5;3M\x1b[<32;5;11M\x1b[<0;50;11m");
    this.assertEqual(
      (await this.session()).workspaces.map((w: any) => w.id),
      [second, third, first],
    );
    await a.input("\x1b[<0;5;3M\x1b[<32;5;11M");
    await a.input("\x1b");
    await sleep(0.1);
    await a.poll();
    await a.input("\x1b[<0;5;11m");
    this.assertEqual(
      (await this.session()).workspaces.map((w: any) => w.id),
      [second, third, first],
    );
    await this.run_cli("reload", EXE);
    this.assertEqual(
      (await this.session()).workspaces.map((w: any) => w.id),
      [second, third, first],
    );
  }

  async test_workspace_scroll_while_dragging_reaches_offscreen_slots() {
    await this.new();
    const first = (await this.session()).workspaces[0].id;
    const second = (await this.command("workspace.create", { name: "Second", cwd: this.temp.name })).workspace;
    const third = (await this.command("workspace.create", { name: "Third", cwd: this.temp.name })).workspace;
    // At 16 rows only one workspace fits, so the end slot needs scrolling.
    const a = await this.newViewer(100, 16);
    await a.input("\x1b[<0;5;3M\x1b[<32;5;6M");
    for (let i = 0; i < 2; i++) await a.input("\x1b[<65;5;6M");
    this.assertIn(`\x1b[3;2H${tinted}`, a.state.data);
    this.assertIn(`\x1b[3;2H${ghostBar}`, a.state.data);
    await a.input("\x1b[<0;5;6m");
    this.assertEqual(
      (await this.session()).workspaces.map((w: any) => w.id),
      [second, third, first],
    );
  }

  async test_sidebar_width_is_local_sticky_and_clamped() {
    const pane = await this.new(),
      a = await this.newViewer(),
      b = await this.newViewer();
    await a.input("\x1b[<0;28;8M\x1b[<32;40;8M\x1b[<0;40;8m");
    await a.poll();
    await b.poll();
    this.assertEqual((await this.geometry())[pane][0], 60);
    this.assertIn("\x1b[1;41H", a.state.data);
    this.assertIn("\x1b[1;29H", b.state.data);
    // New viewers start from the last dragged width; open ones keep their own.
    const c = await this.newViewer();
    await c.poll();
    this.assertIn("\x1b[1;41H", c.state.data);
    await a.input("\x1b[<0;40;8M\x1b[<32;99;8M\x1b[<0;99;8m");
    this.assertEqual((await this.geometry())[pane][0], 20);
    await a.request({ op: "size", cols: 70, rows: 30 });
    this.assertIn("\x1b[1;51H", a.state.data);
  }

  async test_workspace_away_usage_resets_on_visit_and_respects_other_viewers() {
    const pane = await this.new("exec /bin/sh"),
      home = (await this.session()).workspaces[0].id;
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.temp.name,
      })
    ).workspace;
    const session = "01901234-1234-1234-1234-123456789abc";
    const path = join(this.temp.name, "usage.jsonl");
    const tokenLine = (i: number, o: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: i, output_tokens: o } },
      },
    });
    writeFileSync(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: { id: session, instructions: "x".repeat(24 * 1024) },
      }) +
        "\n" +
        JSON.stringify(tokenLine(100, 10)) +
        "\n",
    );
    const terminal = write_codex_terminal(join(this.temp.name, "codex"), session);
    const observer = new CodexObserver(this.env.CODEX_HOME!, [session]);
    observer.paths[session] = path;
    try {
      await this.command("pane.input", { target: pane, data: `exec ${quote(terminal)}\r` });
      await this.until(
        async () => (await this.session()).panes.find((p: any) => p.id === pane).agent.session === session,
      );
    } finally {
      await observer.close();
    }
    await this.rpc({
      op: "hook",
      pane,
      provider: "codex",
      seq: Date.now() * 1000,
      event: {
        hook_event_name: "SessionStart",
        session_id: session,
        transcript_path: path,
      },
    });
    const a = await this.newViewer();
    await a.request({ op: "workspace", workspace: other });
    await sleep(0.8);
    const append = (n: number, i: number, o: number) => {
      const stamp = new Date().toISOString();
      appendFileSync(
        path,
        JSON.stringify({
          type: "response_item",
          timestamp: stamp,
          payload: { type: "function_call", call_id: String(n) },
        }) + "\n",
      );
      appendFileSync(path, JSON.stringify({ ...tokenLine(i, o), timestamp: stamp }) + "\n");
    };
    const counts = async () => (await this.session()).workspaces.find((w: any) => w.id === home).stats;
    append(1, 150, 20);
    await this.until(async () => (await counts()).tools === 1);
    this.assertEqual([(await counts()).input, (await counts()).output], [50, 10]);
    await this.rpc({
      op: "hook",
      pane,
      provider: "codex",
      seq: Date.now() * 1000,
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "request_user_input",
        session_id: session,
      },
    });
    this.assertIn(`\x1b[1m\x1b[38;2;${PALETTE.warm}m ●1`, (await a.poll()).data);
    this.assertNotIn("↓50↑10", a.state.data);
    this.assertIn("●1", screen_text(a.state.data, 100, 30)[3].slice(0, 27));
    this.assertNotIn("unread", screen_text(a.state.data, 100, 30)[3]);
    await a.request({ op: "workspace", workspace: home });
    this.assertEqual((await counts()).tools, 0);
    append(2, 200, 30);
    for (let i = 0; i < 5; i++) {
      await a.poll();
      await sleep(0.15);
    }
    this.assertEqual((await counts()).tools, 0);
    await a.request({ op: "workspace", workspace: other });
    append(3, 230, 35);
    await this.until(async () => (await counts()).tools === 1);
    this.assertEqual([(await counts()).input, (await counts()).output], [30, 5]);
    const b = await this.newViewer();
    await b.request({ op: "workspace", workspace: home });
    this.assertEqual((await counts()).tools, 0);
    append(4, 240, 36);
    for (let i = 0; i < 5; i++) {
      await a.poll();
      await b.poll();
      await sleep(0.15);
    }
    this.assertEqual((await counts()).tools, 0);
  }

  async test_native_usage_and_attention_are_visible_and_survive_reload() {
    await this.new();
    const home = (await this.session()).workspaces[0].id;
    const ident = (
      await this.rpc({
        op: "native.start",
        provider: "codex",
        cwd: this.temp.name,
      })
    ).session;
    const send = (method: string, params: any) =>
      this.rpc({
        op: "native.send",
        session: ident,
        message: { id: 1, method: "test/event", params: { method, params } },
      });
    const counts = async () => (await this.session()).workspaces[0].stats;
    await send("turn/started", { threadId: "t", turn: { id: "turn" } });
    await send("item/started", {
      threadId: "t",
      turnId: "turn",
      item: { id: "tool1", type: "commandExecution" },
    });
    const usage = {
      total: { inputTokens: 100, outputTokens: 10 },
      last: { inputTokens: 100, outputTokens: 10 },
    };
    await send("thread/tokenUsage/updated", {
      threadId: "t",
      tokenUsage: usage,
    });
    await this.until(async () => (await counts()).input === 100);
    this.assertEqual((await counts()).tools, 1);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertEqual([(await counts()).tools, (await counts()).input, (await counts()).output], [1, 100, 10]);
    await send("thread/tokenUsage/updated", {
      threadId: "t",
      tokenUsage: usage,
    });
    await sleep(0.15);
    this.assertEqual((await counts()).input, 100);
    const v = await this.newViewer();
    await v.request({ op: "workspace", workspace: home });
    this.assertEqual((await counts()).tools, 0);
  }

  async test_workspace_context_menu_targets_background_workspace() {
    const first = await this.new("sleep 60", "Keep");
    const ws = (
      await this.command("workspace.create", {
        name: "Target",
        cwd: this.temp.name,
      })
    ).workspace;
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.request({ op: "workspace", workspace: ws });
    await a.input("\x1b[<2;5;6M\x1b[<2;5;6m");
    this.assertIn("Rename", a.state.data);
    await a.input("\r");
    await a.input("Renamed\r");
    this.assertEqual((await this.session()).workspaces.find((w: any) => w.id === ws).custom_name, "Renamed");
    await a.input("\x1b[<2;5;6M\x1b[<2;5;6m");
    await a.input("\x1b[B\r");
    this.assertEqual((await this.session()).workspaces.length, 1);
    this.assertEqual((await a.poll()).pane, first);
    this.assertEqual((await b.poll()).pane, first);
  }

  async test_workspace_name_uses_first_tab_in_both_viewers() {
    const one = join(this.temp.name, "one"),
      two = join(this.temp.name, "two");
    mkdirSync(one);
    mkdirSync(two);
    const first = (await this.open_pane({ cwd: one, command: "exec /bin/sh" })).pane;
    const second = (await this.open_pane({ cwd: two, command: "exec /bin/sh" })).pane;
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(second);
    this.assertEqual(
      screen_text((await a.poll()).data, 100, 30)[2]
        .slice(2, 27)
        .trim(),
      "one",
    );
    this.assertEqual(
      screen_text((await b.poll()).data, 100, 30)[2]
        .slice(2, 27)
        .trim(),
      "one",
    );
    this.assertNotIn("📌", a.state.data);
    await b.action("move-tab", "left");
    this.assertEqual(
      screen_text((await a.poll()).data, 100, 30)[2]
        .slice(2, 27)
        .trim(),
      "two",
    );
    this.assertEqual(
      screen_text((await b.poll()).data, 100, 30)[2]
        .slice(2, 27)
        .trim(),
      "two",
    );
    await b.input("\x02W");
    await b.input("Custom\r");
    this.assertIn("Custom", (await a.poll()).data);
    this.assertIn("Custom", (await b.poll()).data);
    await b.input("\x02W");
    await b.input("\x03\r");
    this.assertEqual((await this.session()).workspaces[0].custom_name, "");
    this.assertEqual(
      screen_text((await a.poll()).data, 100, 30)[2]
        .slice(2, 27)
        .trim(),
      "two",
    );
    await a.action("new");
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === a.state.pane).cwd, realpathSync(one));
  }

  async test_viewer_creation_inherits_its_own_focused_directory() {
    const one = join(this.temp.name, "one"),
      two = join(this.temp.name, "two");
    mkdirSync(one);
    mkdirSync(two);
    const first = (await this.open_pane({ cwd: one, command: "exec /bin/sh" })).pane;
    const second = (await this.open_pane({ cwd: two, command: "exec /bin/sh" })).pane;
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(second);
    await b.action("split", "right");
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === b.state.pane).cwd, realpathSync(two));
    const target = (await this.rpc({ op: "viewer.list" })).viewers[0].id;
    await this.rpc({ op: "focus", pane: second, viewer: target });
    for (const op of ["new", "split"]) {
      await this.rpc({
        op: "action",
        name: op,
        value: op === "split" ? "right" : "",
        viewer: target,
      });
      const created = (await this.client!.poll()).pane;
      this.assertEqual((await this.session()).panes.find((p: any) => p.id === created).cwd, realpathSync(two));
    }
  }

  async test_selection_and_dialogs_are_viewer_specific() {
    const first = await this.new("sleep 60", "First"),
      second = await this.new("sleep 60", "Second");
    const ws = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.temp.name,
      })
    ).workspace;
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(second);
    const before = (await this.session()).workspaces;
    await a.request({ op: "workspace", workspace: ws });
    this.assertEqual((await b.poll()).pane, second);
    await a.request({ op: "workspace", workspace: before[0].id });
    this.assertEqual(a.state.pane, first);
    await a.input("\x02W");
    this.assertTrue(a.state.dialog);
    this.assertFalse((await b.poll()).dialog);
    await b.input("\x02");
    this.assertTrue(b.state.prefix);
    this.assertTrue((await a.poll()).dialog);
    this.assertEqual((await this.session()).workspaces, before);
  }

  async test_arrangement_is_shared_and_close_reconciles_selection() {
    const first = await this.new("sleep 60", "First"),
      second = await this.new("sleep 60", "Second");
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(second);
    const pid = Object.fromEntries((await this.session()).panes.map((p: any) => [p.id, p.pid]));
    await a.action("split", "right");
    const split = a.state.pane;
    await b.poll();
    await b.focus(split);
    await a.action("rename", "Shared");
    await a.action("move-tab", "right");
    this.assertIn("Shared", (await b.poll()).data);
    this.assertEqual(b.state.pane, split);
    await a.action("close");
    this.assertEqual((await b.poll()).pane, first);
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === first).pid, pid[first]);
    this.assertEqual((await this.session()).panes.length, 2);
  }

  async test_sizes_follow_visible_panes_and_expand_after_detach() {
    const first = await this.new(),
      second = await this.new();
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.request({ op: "size", cols: 120, rows: 40 });
    await a.focus(first);
    await b.request({ op: "size", cols: 60, rows: 20 });
    await b.focus(second);
    await a.poll();
    let sizes = await this.geometry();
    this.assertEqual(sizes[first], [92, 39]);
    this.assertEqual(sizes[second], [60, 19]);
    await b.focus(first);
    await a.poll();
    this.assertEqual((await this.geometry())[first], [60, 19]);
    await b.close();
    await a.poll();
    this.assertEqual((await this.geometry())[first], [92, 39]);
  }

  async test_scroll_and_copy_are_private_and_preserve_live_screen() {
    const first = await this.new(
      "i=0; while [ $i -lt 80 ]; do printf 'ROW_%03d\\n' $i; i=$((i+1)); done; exec /bin/sh",
    );
    await this.until(async () =>
      (await this.command("pane.read", { target: first, view: "screen" })).text.includes("ROW_079"),
    );
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(first);
    await a.input("\x02sg");
    this.assertIn("ROW_000", a.state.data);
    this.assertNotIn("ROW_000", (await b.poll()).data);
    this.assertIn("ROW_079", b.state.data);
    this.assertIn("ROW_079", (await this.command("pane.read", { target: first, view: "screen" })).text);
    await a.input("yy");
    this.assertEqual(a.state.effects.length, 2);
    this.assertEqual(a.state.effects[0], a.state.effects[1]);
    this.assertIn("52;c;", a.state.effects[0].write_terminal);
    this.assertEqual((await a.poll()).effects, []);
    this.assertEqual((await b.poll()).effects, []);
    await a.input("q");
    this.assertIn("ROW_079", a.state.data);
  }

  async test_targeted_cli_navigation_and_paste_keep_original_target() {
    const first = await this.new("exec /bin/sh"),
      second = await this.new("exec /bin/sh");
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(first);
    const target = (await this.rpc({ op: "viewer.list" })).viewers[0].id;
    await a.input("\x1b[200~printf PASTE_");
    await this.rpc({ op: "focus", pane: second, viewer: target });
    this.assertEqual((await a.poll()).pane, second);
    this.assertEqual((await b.poll()).pane, first);
    await a.input("STAYS_HERE\\n\x1b[201~\r");
    await this.command("pane.input", { target: first, data: "\r" });
    await this.until(async () =>
      (await this.command("pane.read", { target: first, view: "screen" })).text.includes("PASTE_STAYS_HERE"),
    );
    this.assertNotIn("PASTE_STAYS_HERE", (await this.command("pane.read", { target: second, view: "screen" })).text);
  }

  async test_independent_edits_from_stale_viewers_compose() {
    const first = await this.new("sleep 60", "First"),
      second = await this.new("sleep 60", "Second");
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(second);
    await a.action("rename", "Changed first");
    await b.action("rename", "Changed second");
    this.assertEqual(
      (await this.session()).workspaces[0].model.tabs.map((t: any) => t.title),
      ["Changed first", "Changed second"],
    );
    this.assertEqual((await a.poll()).pane, first);
    this.assertEqual((await b.poll()).pane, second);
  }

  async test_session_edits_reject_invalid_targets_and_stale_dividers_atomically() {
    const first = await this.new(),
      viewer = await this.newViewer();
    await viewer.action("split", "right");
    const second = viewer.state.pane,
      old = (await this.session()).workspaces[0];
    await viewer.action("rename", "New title");
    const before = (await this.session()).workspaces;
    const invalid: [any, string][] = [
      [{ "pane.move": { target: first } }, "MissingField"],
      [{ "pane.swap": { target: first, other: 99999 } }, "NoPane"],
      [{ "split.ratio": { target: first, other: second, ratio: 650 } }, "MissingField"],
      [
        {
          "split.ratio": {
            target: first,
            other: second,
            ratio: 650,
            expected: old.model.revision,
          },
        },
        "StaleLayout",
      ],
      [
        {
          "tab.move": {
            target: old.model.tabs[0].id,
            destination: { beside: second },
          },
        },
        "UnknownField",
      ],
    ];
    for (const [command, error] of invalid) {
      this.assertEqual((await this.raw_rpc({ op: "session.command", protocol: 1, command })).err, error);
      this.assertEqual((await this.session()).workspaces, before);
    }
  }

  async test_viewer_reopen_preserves_daemon_and_pane_processes() {
    const first = await this.new(),
      a = await this.newViewer();
    await a.focus(first);
    const before = await this.session();
    await a.close();
    const b = await this.newViewer(),
      after = await this.session();
    this.assertEqual(before.server_pid, after.server_pid);
    this.assertEqual(
      before.panes.map((p: any) => [p.id, p.pid]),
      after.panes.map((p: any) => [p.id, p.pid]),
    );
    this.assertEqual(b.state.pane, first);
  }

  async test_shared_break_join_and_undo() {
    const first = await this.new(),
      a = await this.newViewer(),
      b = await this.newViewer();
    await a.action("split", "right");
    const split = a.state.pane;
    await b.poll();
    await b.focus(first);
    await a.action("break");
    this.assertEqual(a.state.pane, split);
    this.assertEqual((await this.session()).workspaces[0].model.tabs.length, 2);
    this.assertEqual((await b.poll()).pane, first);
    await a.action("join", "1");
    this.assertEqual(a.state.pane, split);
    await this.mark_agent(split, "Split");
    await a.action("close");
    this.assertEqual(a.state.pane, first);
    await a.action("undo-close");
    this.assertNotIn(a.state.pane, [first, split]);
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === a.state.pane).name, "Split");
    this.assertEqual((await b.poll()).pane, first);
  }

  async test_search_and_selection_copy_do_not_change_other_view() {
    const first = await this.new(
      "printf 'SEARCH_MARKER_unique\\n'; i=0; while [ $i -lt 80 ]; do printf 'tail_%03d\\n' $i; i=$((i+1)); done; exec /bin/sh",
    );
    await this.until(async () =>
      (await this.command("pane.read", { target: first, view: "screen" })).text.includes("tail_079"),
    );
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(first);
    await b.focus(first);
    await a.input("\x02s/SEARCH_MARKER_unique\r");
    this.assertIn("SEARCH_MARKER_unique", a.state.data);
    await a.input("y");
    const effect = a.state.effects[0].write_terminal;
    const encoded = effect.split("52;c;", 2)[1].split("\x07", 1)[0];
    this.assertEqual(Buffer.from(encoded, "base64").toString(), "SEARCH_MARKER_unique");
    this.assertNotIn("SEARCH_MARKER_unique", (await b.poll()).data);
  }

  async test_closing_paste_target_does_not_crash_or_redirect_input() {
    const first = await this.new("exec /bin/sh"),
      second = await this.new("exec /bin/sh");
    const a = await this.newViewer();
    await a.focus(first);
    await a.input("\x1b[200~NOT_A_COMMAND");
    await this.command("pane.close", { target: first });
    await a.input("_SHOULD_DISAPPEAR\x1b[201~");
    this.assertEqual(a.state.pane, second);
    this.assertNotIn("SHOULD_DISAPPEAR", (await this.command("pane.read", { target: second, view: "screen" })).text);
  }

  async test_viewer_encodes_keys_and_mouse_for_child_modes() {
    const fixture = join(this.temp.name, "input.ts"),
      capture = join(this.temp.name, "input.bin");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
process.stdout.write('\\x1b[>1u\\x1b[?1002h\\x1b[?1006hREADY');
const fd = openSync(process.argv[2], 'w');
process.stdin.on('data', data => writeSync(fd, data));
process.stdin.resume();
`,
    );
    const first = await this.new(shellJoin(["bun", fixture, capture]));
    await this.until(async () =>
      (await this.command("pane.read", { target: first, view: "screen" })).text.includes("READY"),
    );
    const a = await this.newViewer();
    await a.focus(first);
    await a.input("\x1b[97;5u");
    await this.until(() => existsSync(capture) && readFileSync(capture).includes(Buffer.from("\x1b[97;5u")));
    await a.input("\x1b[<0;29;2M\x1b[<0;29;2m");
    await this.until(() => readFileSync(capture).includes(Buffer.from("\x1b[<0;1;1M")));
    const before = readFileSync(capture);
    await a.input("\x1b[98;5u");
    this.assertTrue(a.state.prefix);
    await a.input("\x1b");
    this.assertEqual(readFileSync(capture), before);
  }

  async test_arrows_follow_focused_pane_cursor_mode() {
    const fixture = join(this.temp.name, "arrows.ts");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
const fd = openSync(process.argv[2], 'w');
function mode(application) { process.stdout.write(application ? '\\x1b[?1h\\rAPPLICATION' : '\\x1b[?1l\\rNORMAL     '); }
mode(process.argv[3] === 'application');
process.stdin.on('data', data => { for (const byte of data) { if (byte === 110) mode(false); else if (byte === 97) mode(true); else writeSync(fd, Buffer.from([byte])); } });
process.stdin.resume();
`,
    );
    const captures = [0, 1].map(i => join(this.temp.name, `arrows-${i}.bin`));
    const panes: number[] = [];
    for (const [i, mode] of ["application", "normal"].entries())
      panes.push(await this.new(shellJoin(["bun", fixture, captures[i], mode])));
    const viewer = await this.newViewer(),
      expected = [Buffer.alloc(0), Buffer.alloc(0)];
    const syncMode = async (index: number, label: string) => {
      await viewer.focus(panes[index]);
      await this.until(async () => (await viewer.poll()).data.includes(label));
    };
    const arrows = async (index: number, prefix: string) => {
      for (const incoming of ["[", "O"]) {
        await viewer.input(
          "ABCD"
            .split("")
            .map(key => `\x1b${incoming}${key}`)
            .join(""),
        );
        expected[index] = Buffer.concat([
          expected[index],
          Buffer.from(
            "ABCD"
              .split("")
              .map(key => `\x1b${prefix}${key}`)
              .join(""),
          ),
        ]);
        await this.until(
          () => existsSync(captures[index]) && readFileSync(captures[index]).length >= expected[index].length,
        );
        this.assertEqual(readFileSync(captures[index]), expected[index]);
      }
    };
    await syncMode(0, "APPLICATION");
    await arrows(0, "O");
    await syncMode(1, "NORMAL");
    await arrows(1, "[");
    await syncMode(0, "APPLICATION");
    await viewer.input("n");
    await syncMode(0, "NORMAL");
    await arrows(0, "[");
    await viewer.input("a");
    await syncMode(0, "APPLICATION");
    await arrows(0, "O");
    this.assertEqual(readFileSync(captures[1]), expected[1]);
  }

  async test_queued_focus_and_split_execute_in_the_viewer() {
    await this.new();
    const second = await this.new(),
      a = await this.newViewer();
    const first = (await this.session()).panes.find((p: any) => p.id !== second).id;
    await a.focus(first);
    const target = (await this.rpc({ op: "viewer.list" })).viewers[0].id;
    const secondTab = (await this.session()).panes.find((p: any) => p.id === second).tab;
    await this.rpc({ op: "focus", pane: second, viewer: target });
    await this.rpc({
      op: "action",
      name: "split",
      value: "right",
      viewer: target,
    });
    const split = (await a.poll()).pane;
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === split).tab, secondTab);
    this.assertEqual((await a.poll()).pane, split);
    this.assertEqual((await this.session()).panes.length, 3);
  }

  async test_delivered_controls_remain_pending_until_acknowledged() {
    const first = await this.new(),
      second = await this.new();
    const client = await JsonSocket.connect(this.path);
    try {
      const call = (request: any) => client.request({ protocol: 1, viewer_protocol: 3, ...request });
      await call({ op: "viewer.open", cwd: this.temp.name });
      await call({
        op: "viewer.sync",
        interests: [{ pane: first, cols: 80, rows: 24 }],
        focus: first,
      });
      const target = (await this.rpc({ op: "viewer.list" })).viewers[0].id;
      await this.rpc({ op: "focus", pane: second, viewer: target });
      const delivered = (await call({ op: "viewer.sync", interests: [], focus: first })).controls;
      this.assertEqual(delivered[0].id, second);
      this.assertEqual((await call({ op: "viewer.sync", interests: [], focus: first })).controls, delivered);
      this.assertEqual(
        (
          await call({
            op: "viewer.sync",
            interests: [],
            focus: second,
            ack: delivered[0].seq,
          })
        ).controls,
        [],
      );
    } finally {
      client.close();
    }
  }

  async test_agent_exit_freezes_row_then_fades_without_stale_clicks() {
    await this.new();
    const first = await this.new(),
      second = await this.new();
    await this.mark_agent(first, "Departing-agent");
    await this.mark_agent(second, "Surviving-agent");
    await this.rpc({
      op: "hook",
      pane: first,
      provider: "claude",
      seq: 2,
      event: { hook_event_name: "UserPromptSubmit", session_id: String(first) },
    });
    const viewer = await this.newViewer();
    await viewer.focus(second);
    const before = screen_text((await viewer.poll()).data, 100, 30);
    this.assertIn("Departing-agent", before[16].slice(0, 27));
    await this.rpc({
      op: "hook",
      pane: first,
      provider: "claude",
      seq: 3,
      event: { hook_event_name: "SessionEnd", session_id: String(first) },
    });
    const closing = screen_text((await viewer.poll()).data, 100, 30);
    this.assertEqual(before[16].slice(0, 27), closing[16].slice(0, 27));
    this.assertNotIn(
      "Session ended",
      closing
        .slice(16, 28)
        .map(row => row.slice(0, 27))
        .join("\n"),
    );
    this.assertEqual((await viewer.input("\x1b[<0;6;17M\x1b[<0;6;17m")).pane, second);
    await this.command("pane.close", { target: first });
    await sleep(0.3);
    const closed = screen_text((await viewer.poll()).data, 100, 30);
    this.assertIn("Surviving-agent", closed[16].slice(0, 27));
    this.assertNotIn(
      "Departing-agent",
      closed
        .slice(16, 28)
        .map(row => row.slice(0, 27))
        .join("\n"),
    );
    await this.command("pane.close", { target: second });
    const immediate = screen_text((await viewer.poll()).data, 100, 30);
    this.assertIn("Surviving-agent", immediate[16].slice(0, 27));
    await sleep(0.3);
    const completed = screen_text((await viewer.poll()).data, 100, 30);
    this.assertNotIn(
      "Surviving-agent",
      completed
        .slice(16, 28)
        .map(row => row.slice(0, 27))
        .join("\n"),
    );
  }
}

registerCase("Viewers", ViewerScenarios, {
  inherited: false,
  skipTests:
    process.platform === "darwin"
      ? {}
      : {
          test_ghostty_setup_toggle_preserves_config_and_routes_tabs: "Ghostty integration is macOS-only",
        },
});
