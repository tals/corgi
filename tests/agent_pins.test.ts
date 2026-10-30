import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { PALETTE, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, registerCase } from "./support";

// The dragged agent row's strong bar.
const ghost = `\x1b[0;38;2;${PALETTE.strong};48;2;${PALETTE.selected}m▌\x1b[0m`;

const mouse = (button: number, x: number, y: number, release = false) =>
  `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;

// At 30 rows the agent list starts at row 16: the idle section's header, then
// two rows per agent, the newest first. Once one is pinned, the pinned
// section's header is there.
class AgentPins extends Viewers {
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
  labels(viewer: Viewer, rows = 30) {
    return screen_text(viewer.state.data, 100, rows)
      .slice(Math.floor((rows - 1) / 2) + 2)
      .flatMap(row => row.slice(0, 27).match(/Agent-\d+/g) || []);
  }
  /** The screen row showing `text` in the agent list. */
  row(viewer: Viewer, text: string, rows = 30) {
    const screen = screen_text(viewer.state.data, 100, rows);
    return screen.findIndex((row, y) => y > Math.floor((rows - 1) / 2) && row.slice(0, 27).includes(text));
  }
  async pins(index = 0) {
    return (await this.session()).workspaces[index].pinned_agents;
  }

  async test_iterm2_drag_uses_open_hand_and_resets_after_release() {
    await this.agents();
    this.env.TERM_PROGRAM = "iTerm.app";
    const viewer = await this.newViewer();
    this.assertEqual(this.labels(viewer), ["Agent-2", "Agent-1", "Agent-0"]);
    await viewer.input(mouse(0, 6, 21) + mouse(32, 6, 16));
    this.assertIn("\x1b]22;fleur\x1b\\", viewer.state.data);
    this.assertEqual(this.labels(viewer), ["Agent-0", "Agent-2", "Agent-1"]);
    await viewer.input(mouse(0, 6, 16, true));
    this.assertIn("\x1b]22;default\x1b\\", viewer.state.data);
    this.assertNotIn("\x1b]22;fleur\x1b\\", viewer.state.data);
  }

  async test_pins_are_shared_without_moving_tabs_and_survive_reload() {
    const [a, b, c] = await this.agents();
    const first = await this.newViewer(),
      second = await this.newViewer();
    await first.focus(a);
    await second.focus(b);
    const tabs = (await this.session()).workspaces[0].model.tabs;
    // Above the first section, with nothing pinned yet.
    await first.input(mouse(0, 6, 21) + mouse(32, 6, 16));
    this.assertEqual(this.labels(first), ["Agent-0", "Agent-2", "Agent-1"]);
    this.assertIn(ghost, first.state.data);
    this.assertIn("\x1b]22;grabbing\x1b\\", first.state.data);
    // Another viewer's release cannot complete this viewer's drag.
    await second.input(mouse(0, 6, 16, true));
    this.assertEqual(await this.pins(), []);
    this.assertEqual(this.labels(second), ["Agent-2", "Agent-1", "Agent-0"]);
    await first.input(mouse(0, 6, 16, true));
    this.assertEqual(await this.pins(), [{ pane: a }]);
    this.assertIn("pinned", screen_text(first.state.data, 100, 30)[16].slice(0, 27));
    this.assertEqual(this.labels(first), ["Agent-0", "Agent-2", "Agent-1"]);
    // The other rows step aside after a move; read the list once they land.
    await this.until(async () => {
      await second.poll();
      return JSON.stringify(this.labels(second)) === JSON.stringify(this.labels(first));
    });
    this.assertEqual(this.labels(second), this.labels(first));
    this.assertEqual(second.state.pane, b);
    this.assertEqual((await this.session()).workspaces[0].model.tabs, tabs);
    await this.rpc({ op: "server.reload", executable: EXE });
    this.assertEqual(await this.pins(), [{ pane: a }]);
    const third = await this.newViewer();
    this.assertEqual(this.labels(third), ["Agent-0", "Agent-2", "Agent-1"]);
    // Above a pinned agent, one pins before it. A blank row parts the
    // sections, so the idle header is at 20 and Agent-2 at 21.
    await first.poll();
    await first.input(mouse(0, 6, 21) + mouse(32, 6, 17) + mouse(0, 6, 17, true));
    this.assertEqual(await this.pins(), [{ pane: c }, { pane: a }]);
    this.assertEqual(this.labels(first), ["Agent-2", "Agent-0", "Agent-1"]);
    // Dropped among the sections, a pinned agent comes unpinned, back in
    // its section's order.
    await first.input(mouse(0, 6, 19) + mouse(32, 6, 24) + mouse(0, 6, 24, true));
    this.assertEqual(await this.pins(), [{ pane: c }]);
    this.assertEqual(this.labels(first), ["Agent-2", "Agent-1", "Agent-0"]);
  }

  async test_cancel_outside_escape_resize_and_changed_list() {
    const [a, b, c] = await this.agents();
    const viewer = await this.newViewer();
    const begin = () => viewer.input(mouse(0, 6, 21) + mouse(32, 6, 16));
    await begin();
    await viewer.input(mouse(0, 50, 16, true));
    this.assertEqual(await this.pins(), []);
    await begin();
    await viewer.input("\x1b");
    await viewer.input(mouse(0, 6, 16, true));
    this.assertEqual(await this.pins(), []);
    this.assertNotIn("\x1b]22;grabbing\x1b\\", viewer.state.data);
    await begin();
    await viewer.request({ op: "size", cols: 100, rows: 32 });
    await viewer.input(mouse(0, 6, 17, true));
    this.assertEqual(await this.pins(), []);
    await viewer.request({ op: "size", cols: 100, rows: 30 });
    await begin();
    await this.command("pane.close", { target: b });
    await viewer.input(mouse(0, 6, 16, true));
    this.assertEqual(await this.pins(), []);
    this.assertEqual(
      (await this.session()).panes.map((p: any) => p.id),
      [a, c],
    );
  }

  async test_ghost_previews_the_pinned_slot_and_restores_order_outside() {
    await this.agents();
    const viewer = await this.newViewer();
    await viewer.input(mouse(0, 6, 21) + mouse(32, 8, 21));
    this.assertEqual(this.labels(viewer), ["Agent-2", "Agent-1", "Agent-0"]);
    // Within its section, it previews its new place there.
    await viewer.input(mouse(32, 6, 18));
    this.assertEqual(this.labels(viewer), ["Agent-2", "Agent-0", "Agent-1"]);
    await viewer.input(mouse(32, 6, 16));
    this.assertEqual(this.labels(viewer), ["Agent-0", "Agent-2", "Agent-1"]);
    this.assertEqual(await this.pins(), []);
    await viewer.input(mouse(32, 65, 22));
    this.assertEqual(this.labels(viewer), ["Agent-2", "Agent-1", "Agent-0"]);
    this.assertNotIn(ghost, viewer.state.data);
    await viewer.input(mouse(32, 6, 16));
    this.assertEqual(this.labels(viewer), ["Agent-0", "Agent-2", "Agent-1"]);
    await viewer.input("\x1b");
    await this.until(async () => {
      await viewer.poll();
      return this.labels(viewer).join(",") === "Agent-2,Agent-1,Agent-0";
    });
    await viewer.input(mouse(0, 6, 16, true));
    this.assertEqual(await this.pins(), []);
    this.assertNotIn("\x1b]22;grabbing\x1b\\", viewer.state.data);
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
    this.assertEqual(await this.pins(), []);
    this.assertEqual(viewer.state.pane, ids[6]);
  }

  async test_headless_agents_pin_and_cold_recovery_keeps_them() {
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
    await viewer.input(mouse(0, 6, y) + mouse(32, 6, 16) + mouse(0, 6, 16, true));
    const handle = (await this.session()).headless_sessions.find((s: any) => s.session === headless).id;
    this.assertEqual(await this.pins(), [{ headless: handle }]);
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
    this.assertEqual(await this.pins(), [{ headless: handle }]);
  }

  async test_all_pins_within_each_workspace_and_rpc_rejects_other_workspaces() {
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
    await viewer.input(mouse(0, 6, y) + mouse(32, 6, 16) + mouse(0, 6, 16, true));
    this.assertEqual(await this.pins(), []);
    const index = (await this.session()).workspaces.findIndex((w: any) => w.id === other);
    this.assertEqual(await this.pins(index), [{ pane: outsider }]);
    this.assertEqual(this.labels(viewer)[0], "Agent-2");
    const response = await this.raw_rpc({
      op: "session.command",
      command: { "agent.pin": { workspace: home, target: { pane: a }, before: { pane: outsider } } },
    });
    this.assertEqual(response.err, "InvalidDestination");
    this.assertEqual(await this.pins(), []);
  }
}

registerCase("AgentPins", AgentPins);
