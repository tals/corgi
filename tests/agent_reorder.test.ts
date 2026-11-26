import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { PALETTE, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, mouse, registerCase } from "./support";

// The dragged agent row's strong bar.
const ghost = `\x1b[0;38;2;${PALETTE.strong};48;2;${PALETTE.selected}m▌\x1b[0m`;

// The list sorted by hand, the integration suites' default.
class AgentReorder extends Viewers {
  initial_order: { pane: number }[] = [];
  async agents(count = 3) {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const pane = await this.new();
      await this.mark_agent(pane, `Agent-${i}`);
      ids.push(pane);
    }
    // Drag scenarios start in label order, independent of insertion order.
    const workspace = (await this.session()).workspaces[0].id;
    for (const pane of ids) await this.command("agent.move", { workspace, target: { pane }, before: null });
    this.initial_order = ids.map(pane => ({ pane }));
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

  async test_multiselection_is_viewer_local_and_bulk_actions_use_its_members() {
    const [a, b, c] = await this.agents();
    const first = await this.newViewer(),
      second = await this.newViewer();
    await first.focus(a);
    await second.focus(c);
    await first.input("\x02av\x1b[Bv");
    this.assertIn("2 selected", screen_text(first.state.data, 100, 30).join("\n"));
    await second.poll();
    this.assertNotIn("selected", screen_text(second.state.data, 100, 30).join("\n"));
    this.assertEqual(second.state.pane, c);
    await first.input("ms");
    this.assertEqual((await this.session()).workspaces[0].pinned_agents, [{ pane: a }, { pane: b }]);
    await first.input("m");
    const starred = screen_text(first.state.data, 100, 30).join("\n");
    this.assertIn("Unstar 2 agents", starred);
    this.assertNotIn("Star 2 agents", starred);
    await first.input("s");
    this.assertEqual((await this.session()).workspaces[0].pinned_agents, []);
    const workspace = (await this.session()).workspaces[0].id;
    await this.command("agent.pin", { workspace, target: { pane: a }, pinned: true });
    await first.poll();
    await first.input("m");
    const mixed = screen_text(first.state.data, 100, 30).join("\n");
    this.assertIn("Star 2 agents", mixed);
    this.assertNotIn("Unstar 2 agents", mixed);
    await first.input("s");
    this.assertEqual((await this.session()).workspaces[0].pinned_agents, [{ pane: a }, { pane: b }]);
    await first.input("mx");
    this.assertIn("Close 2 agent panes", screen_text(first.state.data, 100, 30).join("\n"));
    this.assertEqual(
      (await this.session()).panes.map((p: any) => p.id),
      [a, b, c],
    );
    await first.input("\r"); // Cancel is initially highlighted.
    this.assertEqual(
      (await this.session()).panes.map((p: any) => p.id),
      [a, b, c],
    );
    await first.input("mxy");
    this.assertEqual(
      (await this.session()).panes.map((p: any) => p.id),
      [c],
    );
  }

  async test_ctrl_click_selects_without_changing_the_presented_agent() {
    const [a, b] = await this.agents();
    const viewer = await this.newViewer();
    await viewer.focus(a);
    await viewer.input(mouse(16, 6, 18) + mouse(16, 6, 18, true));
    this.assertEqual(viewer.state.pane, a);
    this.assertIn("2 selected", screen_text(viewer.state.data, 100, 30).join("\n"));
    this.assertNotIn("↓ Agent-1 ↓", screen_text(viewer.state.data, 100, 30).join("\n"));
    await viewer.input(mouse(16, 6, 16) + mouse(16, 6, 16, true));
    this.assertEqual(viewer.state.pane, a);
    this.assertIn("1 selected", screen_text(viewer.state.data, 100, 30).join("\n"));
    await viewer.input("ms");
    this.assertEqual((await this.session()).workspaces[0].pinned_agents, [{ pane: b }]);
    await viewer.input("\x1b[B\r");
    this.assertEqual(viewer.state.pane, b);
    this.assertNotIn("1 selected", screen_text(viewer.state.data, 100, 30).join("\n"));
  }

  async test_selection_menu_restores_the_agents_drawer_after_cancel_and_action() {
    const [a] = await this.agents(),
      viewer = await this.newViewer();
    const sidebar = () =>
      screen_text(viewer.state.data, 100, 30)
        .slice(1)
        .map(row => row.slice(0, 27))
        .join("\n");
    await viewer.focus(a);
    await viewer.input("\x02b\x02a ");
    this.assertIn("1 selected", sidebar());
    await viewer.input("m");
    await viewer.input("\x1b[27u");
    this.assertIn("1 selected", sidebar());
    await viewer.input("ms");
    this.assertEqual((await this.session()).workspaces[0].pinned_agents, [{ pane: a }]);
    this.assertIn("1 selected", sidebar());
    await viewer.input("\x1b[27u");
    this.assertIn("0 selected", sidebar());
    await viewer.input("\x1b[27u");
    this.assertNotIn("agents:", sidebar());
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
    // Below the tab row, which names each tab for its agent.
    this.assertNotIn(
      "Agent-0",
      screen_text(first.state.data, 100, 30)
        .slice(1)
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
    this.assertEqual(await this.order(), this.initial_order);
    this.assertEqual(this.labels(second), ["Agent-0", "Agent-1", "Agent-2"]);
    await first.input(mouse(0, 6, 21, true));
    this.assertEqual(await this.order(), [{ pane: b }, { pane: c }, { pane: a }]);
    this.assertEqual(this.labels(first), ["Agent-1", "Agent-2", "Agent-0"]);
    this.assertNotIn(
      "Agent-0",
      screen_text(first.state.data, 100, 30)
        .slice(1)
        .map(row => row.slice(28))
        .join("\n"),
    );
    // The other rows step aside after a move; read the list once they land.
    await this.until(async () => {
      await second.poll();
      return JSON.stringify(this.labels(second)) === JSON.stringify(this.labels(first));
    });
    this.assertEqual(this.labels(second), this.labels(first));
    this.assertEqual(second.state.pane, b);
    this.assertEqual((await this.session()).workspaces[0].model.tabs, tabs);
    this.assertEqual((await first.input("\x02]")).pane, b);
    await this.rpc({ op: "server.reload", executable: EXE });
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
    this.assertEqual(await this.order(), this.initial_order);
    await begin();
    await viewer.input("\x1b");
    await viewer.input(mouse(0, 6, 21, true));
    this.assertEqual(await this.order(), this.initial_order);
    this.assertNotIn("\x1b]22;grabbing\x1b\\", viewer.state.data);
    await begin();
    await viewer.request({ op: "size", cols: 100, rows: 32 });
    await viewer.input(mouse(0, 6, 22, true));
    this.assertEqual(await this.order(), this.initial_order);
    await viewer.request({ op: "size", cols: 100, rows: 30 });
    await begin();
    await this.command("pane.close", { target: b });
    // A drop is made on the list the viewer has; let it see the close first.
    await viewer.poll();
    await viewer.input(mouse(0, 6, 21, true));
    this.assertEqual(await this.order(), this.initial_order);
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
    this.assertEqual(await this.order(), this.initial_order);
    const screen = screen_text(viewer.state.data, 100, 30);
    this.assertFalse(screen.slice(1, -1).some(row => row.slice(28).includes("Agent-")));
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
    this.assertEqual(await this.order(), this.initial_order);
    this.assertNotIn("\x1b]22;grabbing\x1b\\", viewer.state.data);
  }

  async test_scroll_while_dragging_reaches_offscreen_agents() {
    const ids = await this.agents(7);
    // At 20 rows four agents fit, above the bottom row.
    const viewer = await this.newViewer(100, 20);
    await viewer.focus(ids[0]);
    await viewer.input(mouse(0, 6, 11) + mouse(32, 6, 18));
    for (let i = 0; i < 5; i++) await viewer.input(mouse(65, 6, 18));
    this.assertIn("Agent-0", screen_text(viewer.state.data, 100, 20)[17].slice(0, 27));
    this.assertEqual(this.labels(viewer, 20), ["Agent-4", "Agent-5", "Agent-6", "Agent-0"]);
    await viewer.input(mouse(0, 6, 18, true));
    this.assertEqual(
      await this.order(),
      [...ids.slice(1), ids[0]].map(pane => ({ pane })),
    );
    this.assertEqual(viewer.state.pane, ids[0]);
  }

  async test_drag_edges_scroll_gradually_and_drop_into_the_scrolled_list() {
    const ids = await this.agents(7),
      viewer = await this.newViewer(100, 20);
    await viewer.focus(ids[0]);
    await viewer.input(mouse(0, 6, 11) + mouse(32, 6, 18));
    await viewer.advance(1);
    this.assertEqual(this.labels(viewer, 20), ["Agent-1", "Agent-2", "Agent-3", "Agent-0", "Agent-4"]);
    await viewer.input(mouse(32, 6, 19));
    await viewer.advance(0.4);
    this.assertEqual(this.labels(viewer, 20), ["Agent-2", "Agent-3", "Agent-4", "Agent-0", "Agent-5"]);
    await viewer.advance(0.18);
    this.assertEqual(this.labels(viewer, 20), ["Agent-3", "Agent-4", "Agent-5", "Agent-0", "Agent-6"]);
    // Returning to the last visible slot stops the clock.
    await viewer.input(mouse(32, 6, 18));
    await viewer.advance(1);
    this.assertEqual(this.labels(viewer, 20), ["Agent-3", "Agent-4", "Agent-5", "Agent-0", "Agent-6"]);
    await viewer.input(mouse(32, 6, 19));
    await viewer.advance(0.4);
    this.assertEqual(this.labels(viewer, 20), ["Agent-4", "Agent-5", "Agent-6", "Agent-0"]);
    await viewer.input(mouse(0, 6, 19, true));
    await viewer.advance(1);
    this.assertEqual(
      await this.order(),
      [...ids.slice(1), ids[0]].map(pane => ({ pane })),
    );
    this.assertEqual(this.labels(viewer, 20), ["Agent-4", "Agent-5", "Agent-6", "Agent-0"]);
    // The first slot stays still too; the gap above it scrolls upward.
    await viewer.input(mouse(0, 6, 17) + mouse(32, 6, 11));
    await viewer.advance(1);
    this.assertEqual(this.labels(viewer, 20), ["Agent-0", "Agent-4", "Agent-5", "Agent-6"]);
    await viewer.input(mouse(32, 6, 10));
    await viewer.advance(0.4);
    this.assertEqual(this.labels(viewer, 20), ["Agent-0", "Agent-3", "Agent-4", "Agent-5", "Agent-6"]);
    await viewer.advance(0.18);
    await viewer.advance(0.18);
    await viewer.input(mouse(0, 6, 10, true));
    this.assertEqual(await this.order(), this.initial_order);
    this.assertEqual(this.labels(viewer, 20), ["Agent-0", "Agent-1", "Agent-2", "Agent-3", "Agent-4"]);
    await viewer.input(mouse(0, 6, 11) + mouse(32, 6, 19));
    await viewer.input("\x1b[O");
    await viewer.advance(1);
    this.assertEqual(this.labels(viewer, 20), ["Agent-0", "Agent-1", "Agent-2", "Agent-3", "Agent-4"]);
    await viewer.input(mouse(0, 6, 19, true));
    this.assertEqual(await this.order(), this.initial_order);
  }

  async test_headless_agents_share_order_and_cold_recovery_preserves_it() {
    const [a, b] = await this.agents(2);
    const workspace = (await this.session()).workspaces[0].id;
    const headless = (
      await this.rpc({
        op: "headless.start",
        prompt: "test/init",
        provider: "codex",
        cwd: this.temp.name,
        workspace,
      })
    ).session;
    const viewer = await this.newViewer();
    const handle = (await this.session()).headless_sessions.find((s: any) => s.session === headless).id;
    const order = [{ headless: handle }, { pane: a }, { pane: b }];
    this.assertEqual(await this.order(), order);
    this.assertIn("Codex", screen_text(viewer.state.data, 100, 30)[16]);
    const added = await this.new();
    await this.mark_agent(added, "Agent-3");
    await this.until(async () => {
      await viewer.poll();
      return this.labels(viewer).join(",") === "Agent-3,Agent-0,Agent-1";
    });
    this.assertEqual(await this.order(), [{ pane: added }, ...order]);
    await this.rpc({ op: "recovery.save" });
    await viewer.close();
    await this.restart_runtime();
    // Recovery adds a pane for the running headless session; saved rows keep their order.
    const recovered = (await this.session()).panes.find((p: any) => ![a, b, added].includes(p.id));
    this.assertTrue(recovered);
    this.assertEqual(await this.order(), [{ pane: recovered.id }, { pane: added }, ...order]);
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
    this.assertEqual(await this.order(), this.initial_order);
    await viewer.input(mouse(0, 6, 17) + mouse(32, 6, 20));
    this.assertEqual(this.labels(viewer), ["Agent-1", "Agent-0", "Agent-2"]);
    this.assertIn("Elsewhere", screen_text(viewer.state.data, 100, 30)[21]);
    await viewer.input(mouse(0, 6, 20, true));
    this.assertEqual(await this.order(), [{ pane: b }, { pane: a }]);
    const response = await this.raw_rpc({
      op: "session.command",
      command: { "agent.move": { workspace: home, target: { pane: a }, before: { pane: outsider } } },
    });
    this.assertEqual(response.err, "InvalidDestination");
    this.assertEqual(await this.order(), [{ pane: b }, { pane: a }]);
  }
}

registerCase("AgentReorder", AgentReorder);

// At 30 rows the agent list starts at row 16: the idle section's header, then
// two rows per agent, the newest first. Once one is starred, the starred
// section's header is there.
class AgentStars extends AgentReorder {
  async setUp() {
    await super.setUp();
    writeFileSync(
      join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"),
      JSON.stringify({ onboarding_complete: true, agent_sort: "activity" }),
    );
  }
  async agents(count = 3) {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const pane = await this.new();
      await this.mark_agent(pane, `Agent-${i}`);
      ids.push(pane);
      // The daemon puts a new agent first in its section on its next tick.
      await this.until(async () => (await this.session()).workspaces[0].activity_order[0]?.pane === pane);
    }
    return ids;
  }
  /** The screen row showing `text` in the agent list. */
  row(viewer: Viewer, text: string, rows = 30) {
    const screen = screen_text(viewer.state.data, 100, rows);
    return screen.findIndex((row, y) => y > Math.floor((rows - 1) / 2) && row.slice(0, 27).includes(text));
  }
  async stars(index = 0) {
    return (await this.session()).workspaces[index].pinned_agents;
  }

  async test_new_agent_waits_in_working_until_its_first_prompt() {
    await this.agents(1);
    const viewer = await this.newViewer(),
      pane = await this.new();
    await this.mark_agent(pane, "Agent-1");
    await this.until(async () => {
      await viewer.poll();
      // Agent-0 has had no prompt either; the newer one goes on top.
      const working = this.row(viewer, "working"),
        added = this.row(viewer, "Agent-1"),
        older = this.row(viewer, "Agent-0");
      return working > 0 && added === working + 1 && older > added;
    });
    this.assertEqual((await this.session()).panes.find((p: any) => p.id === pane).agent.state, "idle");
    const row = this.row(viewer, "Agent-1");
    await viewer.focus(pane);
    await viewer.advance(1);
    this.assertEqual(this.row(viewer, "Agent-1"), row);
    await this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: 2,
      event: { hook_event_name: "UserPromptSubmit", session_id: String(pane) },
    });
    await this.until(async () => {
      await viewer.poll();
      return (await this.session()).panes.find((p: any) => p.id === pane).agent.state === "working";
    });
    this.assertEqual(this.row(viewer, "Agent-1"), row);
  }

  async test_stars_are_shared_without_moving_tabs_and_survive_reload() {
    const [a, b, c] = await this.agents();
    const first = await this.newViewer(),
      second = await this.newViewer();
    await first.focus(a);
    await second.focus(b);
    const tabs = (await this.session()).workspaces[0].model.tabs;
    await first.action("star-agent", String(a));
    this.assertEqual(await this.stars(), [{ pane: a }]);
    this.assertIn("★ starred", screen_text(first.state.data, 100, 30)[16].slice(0, 27));
    await this.until(async () => {
      await second.poll();
      return JSON.stringify(this.labels(second)) === JSON.stringify(this.labels(first));
    });
    this.assertEqual(this.labels(first), ["Agent-0", "Agent-2", "Agent-1"]);
    this.assertEqual(second.state.pane, b);
    this.assertEqual((await this.session()).workspaces[0].model.tabs, tabs);
    await this.rpc({ op: "server.reload", executable: EXE });
    this.assertEqual(await this.stars(), [{ pane: a }]);
    const third = await this.newViewer();
    this.assertEqual(this.labels(third), ["Agent-0", "Agent-2", "Agent-1"]);
    await first.action("star-agent", String(c));
    this.assertEqual(await this.stars(), [{ pane: a }, { pane: c }]);
    // Starred rows can reorder each other, but cannot be dragged out.
    await first.input(mouse(0, 6, 19) + mouse(32, 6, 17) + mouse(0, 6, 17, true));
    this.assertEqual(await this.stars(), [{ pane: c }, { pane: a }]);
    await first.input(mouse(0, 6, 19) + mouse(32, 6, 24) + mouse(0, 6, 24, true));
    this.assertEqual(await this.stars(), [{ pane: c }, { pane: a }]);
    await first.action("star-agent", String(a));
    this.assertEqual(await this.stars(), [{ pane: c }]);
    this.assertEqual((await this.session()).workspaces[0].model.tabs, tabs);
  }

  async test_scroll_while_dragging_reorders_a_section_past_the_fold() {
    const ids = await this.agents(7);
    const viewer = await this.newViewer(100, 20);
    await viewer.focus(ids[6]);
    // The newest is first, right under the section's header at row 11.
    this.assertEqual(this.row(viewer, "Agent-6", 20), 12);
    await viewer.input(mouse(0, 6, 12) + mouse(32, 6, 18));
    for (let i = 0; i < 6; i++) await viewer.input(mouse(65, 6, 18));
    await viewer.input(mouse(32, 6, 19));
    this.assertEqual(this.labels(viewer, 20).at(-1), "Agent-6");
    await viewer.input(mouse(0, 6, 19, true));
    const order = (await this.session()).workspaces[0].activity_order;
    this.assertEqual(order.at(-1), { pane: ids[6] });
    this.assertEqual(await this.stars(), []);
    this.assertEqual(viewer.state.pane, ids[6]);
  }

  async test_headless_agents_star_from_the_menu_and_cold_recovery_keeps_them() {
    await this.agents(2);
    const workspace = (await this.session()).workspaces[0].id;
    const headless = (
      await this.rpc({
        op: "headless.start",
        prompt: "test/init",
        provider: "codex",
        cwd: this.temp.name,
        workspace,
      })
    ).session;
    const viewer = await this.newViewer();
    await this.until(async () => {
      await viewer.poll();
      return this.row(viewer, "Codex") > 0;
    });
    const y = this.row(viewer, "Codex");
    await viewer.input(mouse(2, 6, y) + mouse(2, 6, y, true));
    await viewer.input("s");
    const handle = (await this.session()).headless_sessions.find((s: any) => s.session === headless).id;
    this.assertEqual(await this.stars(), [{ headless: handle }]);
    this.assertIn("Codex", screen_text(viewer.state.data, 100, 30)[17]);
    const added = await this.new();
    await this.mark_agent(added, "Agent-3");
    // The rows below step down as one arrives; read the list once they land.
    await this.until(async () => {
      await viewer.poll();
      return JSON.stringify(this.labels(viewer).sort()) === JSON.stringify(["Agent-0", "Agent-1", "Agent-3"]);
    });
    this.assertEqual(this.labels(viewer).sort(), ["Agent-0", "Agent-1", "Agent-3"]);
    await this.rpc({ op: "recovery.save" });
    await viewer.close();
    await this.restart_runtime();
    const recovered = (await this.session()).panes.find((pane: any) => pane.agent.session === headless);
    this.assertTrue(recovered);
    this.assertEqual(await this.stars(), [{ headless: handle }, { pane: recovered.id }]);
  }

  async test_all_stars_within_each_workspace_and_rpc_rejects_other_workspaces() {
    const [a] = await this.agents(2);
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
    // Each workspace's subhead names it.
    this.assertTrue(this.row(viewer, "Elsewhere") > 0);
    const y = this.row(viewer, "Agent-2");
    await viewer.input(mouse(2, 6, y) + mouse(2, 6, y, true));
    await viewer.input("s");
    this.assertEqual(await this.stars(), []);
    const index = (await this.session()).workspaces.findIndex((w: any) => w.id === other);
    this.assertEqual(await this.stars(index), [{ pane: outsider }]);
    this.assertEqual(this.labels(viewer)[0], "Agent-2");
    const response = await this.raw_rpc({
      op: "session.command",
      command: { "agent.pin": { workspace: home, target: { pane: a }, before: { pane: outsider } } },
    });
    this.assertEqual(response.err, "InvalidDestination");
    this.assertEqual(await this.stars(), []);
  }
}

registerCase("AgentStars", AgentStars, { inherited: false });
