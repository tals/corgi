import { Viewers } from "./viewers";
import { PALETTE, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, registerCase } from "./support";

// The dragged agent row's strong bar.
const ghost = `\x1b[0;38;2;${PALETTE.strong};48;2;${PALETTE.selected}m▌\x1b[0m`;

const mouse = (button: number, x: number, y: number, release = false) =>
  `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;

class AgentReorder extends Viewers {
  async agents(count = 3) {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const pane = await this.new();
      await this.mark_agent(pane, `Agent-${i}`);
      ids.push(pane);
    }
    return ids;
  }
  labels(viewer: Viewer, rows = 30) {
    return screen_text(viewer.state.data, 100, rows)
      .slice(Math.floor((rows - 1) / 2) + 2)
      .flatMap(row => row.slice(0, 27).match(/Agent-\d+/g) || []);
  }
  async order() {
    return (await this.session()).workspaces[0].agent_order;
  }

  async test_iterm2_drag_uses_open_hand_and_resets_after_release() {
    await this.agents();
    this.env.TERM_PROGRAM = "iTerm.app";
    const viewer = await this.newViewer();
    await viewer.input(mouse(0, 6, 16) + mouse(32, 6, 21));
    this.assertIn("\x1b]22;fleur\x1b\\", viewer.state.data);
    this.assertEqual(this.labels(viewer), ["Agent-1", "Agent-2", "Agent-0"]);
    await viewer.input(mouse(0, 6, 21, true));
    this.assertIn("\x1b]22;default\x1b\\", viewer.state.data);
    this.assertNotIn("\x1b]22;fleur\x1b\\", viewer.state.data);
  }

  async test_drag_order_is_shared_without_moving_tabs_and_survives_reload() {
    const [a, b, c] = await this.agents();
    const first = await this.newViewer(),
      second = await this.newViewer();
    await first.focus(a);
    await second.focus(b);
    const tabs = (await this.session()).workspaces[0].model.tabs;
    await first.input(mouse(0, 6, 16));
    this.assertNotIn(
      "Agent-0",
      screen_text(first.state.data, 100, 30)
        .map(row => row.slice(28))
        .join("\n"),
    );
    await first.input(mouse(32, 6, 21));
    const screen = screen_text(first.state.data, 100, 30);
    this.assertIn("Agent-0", screen[20].slice(0, 27));
    this.assertEqual(this.labels(first), ["Agent-1", "Agent-2", "Agent-0"]);
    this.assertIn(ghost, first.state.data);
    this.assertIn("\x1b]22;grabbing\x1b\\", first.state.data);
    // Another viewer's release cannot complete this viewer's drag.
    await second.input(mouse(0, 6, 21, true));
    this.assertEqual(await this.order(), []);
    this.assertEqual(this.labels(second), ["Agent-0", "Agent-1", "Agent-2"]);
    await first.input(mouse(0, 6, 21, true));
    this.assertEqual(await this.order(), [{ pane: b }, { pane: c }, { pane: a }]);
    this.assertEqual(this.labels(first), ["Agent-1", "Agent-2", "Agent-0"]);
    this.assertNotIn(
      "Agent-0",
      screen_text(first.state.data, 100, 30)
        .map(row => row.slice(28))
        .join("\n"),
    );
    await second.poll();
    this.assertEqual(this.labels(second), this.labels(first));
    this.assertEqual(second.state.pane, b);
    this.assertEqual((await this.session()).workspaces[0].model.tabs, tabs);
    this.assertEqual((await first.input("\x02]")).pane, b);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertEqual(await this.order(), [{ pane: b }, { pane: c }, { pane: a }]);
    await first.poll();
    this.assertEqual(this.labels(first), ["Agent-1", "Agent-2", "Agent-0"]);
    const third = await this.newViewer();
    this.assertEqual(this.labels(third), ["Agent-1", "Agent-2", "Agent-0"]);
    // Moving up uses the first row's top half, including the first slot.
    await first.input(mouse(0, 6, 20) + mouse(32, 6, 16));
    this.assertEqual(this.labels(first), ["Agent-0", "Agent-1", "Agent-2"]);
    await first.input(mouse(0, 6, 16, true));
    this.assertEqual(await this.order(), [{ pane: a }, { pane: b }, { pane: c }]);
  }

  async test_cancel_outside_escape_resize_and_changed_list() {
    const [a, b, c] = await this.agents();
    const viewer = await this.newViewer();
    const begin = () => viewer.input(mouse(0, 6, 16) + mouse(32, 6, 21));
    await begin();
    await viewer.input(mouse(0, 50, 21, true));
    this.assertEqual(await this.order(), []);
    await begin();
    await viewer.input("\x1b");
    await viewer.input(mouse(0, 6, 21, true));
    this.assertEqual(await this.order(), []);
    this.assertNotIn("\x1b]22;grabbing\x1b\\", viewer.state.data);
    await begin();
    await viewer.request({ op: "size", cols: 100, rows: 32 });
    await viewer.input(mouse(0, 6, 22, true));
    this.assertEqual(await this.order(), []);
    await viewer.request({ op: "size", cols: 100, rows: 30 });
    await begin();
    await this.command("pane.close", { target: b });
    await viewer.input(mouse(0, 6, 21, true));
    this.assertEqual(await this.order(), []);
    this.assertEqual(
      (await this.session()).panes.map((p: any) => p.id),
      [a, c],
    );
  }

  async test_ghost_previews_the_target_slot_and_restores_order_outside() {
    await this.agents();
    const viewer = await this.newViewer();
    await viewer.input(mouse(0, 6, 17) + mouse(32, 8, 17));
    this.assertEqual(this.labels(viewer), ["Agent-0", "Agent-1", "Agent-2"]);
    await viewer.input(mouse(32, 6, 21));
    this.assertEqual(this.labels(viewer), ["Agent-1", "Agent-2", "Agent-0"]);
    this.assertEqual(await this.order(), []);
    const screen = screen_text(viewer.state.data, 100, 30);
    this.assertFalse(screen.slice(0, -1).some(row => row.slice(28).includes("Agent-")));
    await viewer.input(mouse(32, 65, 22));
    this.assertEqual(this.labels(viewer), ["Agent-0", "Agent-1", "Agent-2"]);
    this.assertNotIn(ghost, viewer.state.data);
    await viewer.input(mouse(32, 6, 19));
    this.assertEqual(this.labels(viewer), ["Agent-1", "Agent-0", "Agent-2"]);
    await viewer.input("\x1b");
    await this.until(async () => {
      await viewer.poll();
      return this.labels(viewer).join(",") === "Agent-0,Agent-1,Agent-2";
    });
    this.assertEqual(this.labels(viewer), ["Agent-0", "Agent-1", "Agent-2"]);
    await viewer.input(mouse(0, 6, 19, true));
    this.assertEqual(await this.order(), []);
    this.assertNotIn("\x1b]22;grabbing\x1b\\", viewer.state.data);
  }

  async test_scroll_while_dragging_reaches_offscreen_agents() {
    const ids = await this.agents(7);
    const viewer = await this.newViewer(100, 18);
    await viewer.focus(ids[0]);
    await viewer.input(mouse(0, 6, 10) + mouse(32, 6, 17));
    for (let i = 0; i < 5; i++) await viewer.input(mouse(65, 6, 17));
    this.assertIn("Agent-0", screen_text(viewer.state.data, 100, 18)[16].slice(0, 27));
    this.assertEqual(this.labels(viewer, 18), ["Agent-4", "Agent-5", "Agent-6", "Agent-0"]);
    await viewer.input(mouse(0, 6, 17, true));
    this.assertEqual(
      await this.order(),
      [...ids.slice(1), ids[0]].map(pane => ({ pane })),
    );
    this.assertEqual(viewer.state.pane, ids[0]);
  }

  async test_native_agents_share_order_and_cold_recovery_preserves_it() {
    const [a, b] = await this.agents(2);
    const workspace = (await this.session()).workspaces[0].id;
    const native = (await this.rpc({ op: "native.start", provider: "codex", cwd: this.temp.name, workspace })).session;
    const viewer = await this.newViewer();
    await viewer.input(mouse(0, 6, 20) + mouse(32, 6, 16) + mouse(0, 6, 16, true));
    const order = [{ native }, { pane: a }, { pane: b }];
    this.assertEqual(await this.order(), order);
    this.assertIn("codex", screen_text(viewer.state.data, 100, 30)[16]);
    const added = await this.new();
    await this.mark_agent(added, "Agent-3");
    await viewer.poll();
    this.assertEqual(this.labels(viewer), ["Agent-0", "Agent-1", "Agent-3"]);
    await this.rpc({ op: "recovery.save", protocol: 1 });
    await viewer.close();
    await this.restart_runtime();
    this.assertEqual(await this.order(), order);
  }

  async test_grouped_drag_stays_within_workspace_and_rpc_rejects_other_workspaces() {
    const [a, b] = await this.agents(2);
    const home = (await this.session()).workspaces[0].id;
    const other = (await this.command("workspace.create", { name: "Elsewhere", cwd: this.temp.name })).workspace;
    const outsider = (await this.command("pane.create", { workspace: other, cwd: this.temp.name, command: "sleep 60" }))
      .pane;
    await this.mark_agent(outsider, "Agent-2");
    const viewer = await this.newViewer();
    await viewer.focus(a);
    await viewer.input(mouse(0, 10, 14) + mouse(0, 10, 14, true));
    await viewer.input(mouse(0, 8, 17) + mouse(0, 8, 17, true));
    this.assertIn("agents: all", screen_text(viewer.state.data, 100, 30)[14]);
    await viewer.input(mouse(0, 6, 17) + mouse(32, 6, 23) + mouse(0, 6, 23, true));
    this.assertEqual(await this.order(), []);
    await viewer.input(mouse(0, 6, 17) + mouse(32, 6, 20));
    this.assertEqual(this.labels(viewer), ["Agent-1", "Agent-0", "Agent-2"]);
    this.assertIn("Elsewhere", screen_text(viewer.state.data, 100, 30)[21]);
    await viewer.input(mouse(0, 6, 20, true));
    this.assertEqual(await this.order(), [{ pane: b }, { pane: a }]);
    const response = await this.raw_rpc({
      op: "session.command",
      protocol: 1,
      command: { "agent.move": { workspace: home, target: { pane: a }, before: { pane: outsider } } },
    });
    this.assertEqual(response.err, "InvalidDestination");
    this.assertEqual(await this.order(), [{ pane: b }, { pane: a }]);
  }
}

registerCase("AgentReorder", AgentReorder);
