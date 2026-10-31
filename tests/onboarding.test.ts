/** Fresh viewers finish onboarding before any pane has been created. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase } from "./support";

class Onboarding extends Runtime {
  async configure() {
    writeFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"), JSON.stringify({ onboarding_complete: false }));
  }
  async clickText(view: Viewer, label: string) {
    const rows = screen_text(view.state.data, 100, 30);
    const y = rows.findIndex(row => row.includes(label));
    this.assertTrue(y >= 0, `Missing ${label}`);
    const x = rows[y].indexOf(label);
    return view.input(`\x1b[<0;${x + 2};${y + 1}M\x1b[<0;${x + 2};${y + 1}m`);
  }
  async start(mouse = false) {
    const view = await Viewer.create(this, 100, 30);
    this.assertIn("Which shortcuts feel like home?", view.state.data);
    this.assertEqual((await this.session()).panes.length, 0);
    await view.input("\r");
    this.assertIn("Bring your work along", view.state.data);
    if (mouse) await this.clickText(view, "S Skip import");
    else await view.input("s");
    this.assertFalse(view.state.detached);
    this.assertIn("New terminal", view.state.data);
    this.assertEqual((await this.session()).panes.length, 0);
    this.assertTrue(
      JSON.parse(readFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"), "utf8")).onboarding_complete,
    );
    return view;
  }
  async terminal(view: Viewer) {
    this.assertFalse(view.state.detached);
    this.assertTrue(view.state.pane > 0);
    this.assertEqual((await this.session()).panes.length, 1);
    await view.input("printf 'CORGI_ONBOARD_%s\\n' READY\r");
    await this.until(async () => (await view.poll()).data.includes("CORGI_ONBOARD_READY"));
  }
  async finish(mouse: boolean) {
    const view = await this.start(mouse);
    await this.clickText(view, "New terminal");
    await this.terminal(view);
  }
  async test_keyboard_completion_opens_launcher_and_runs_terminal() {
    await this.finish(false);
  }
  async test_mouse_completion_opens_launcher_and_runs_terminal() {
    await this.finish(true);
  }
  async test_escape_from_fresh_launcher_opens_a_terminal() {
    const view = await this.start();
    await view.input("\x1b");
    await this.until(async () => (await view.poll()).pane > 0);
    await this.terminal(view);
    const pane = view.state.pane;
    await view.action("new");
    await view.input("\x1b[27u");
    this.assertFalse(view.state.detached);
    this.assertEqual(view.state.pane, pane);
    this.assertEqual((await this.session()).panes.length, 1);
  }
  async test_escape_from_fresh_manager_opens_a_terminal() {
    const view = await this.start();
    await view.input("\x1b[C");
    await view.advance(0.3);
    this.assertIn("Active ·", view.state.data);
    this.assertIn("Hidden ·", view.state.data);
    await view.input("\x1b[27u");
    await this.terminal(view);
  }
  async test_fresh_manager_removes_and_restores_agents_without_detaching() {
    const view = await this.start();
    await view.input("\x1b[C");
    await view.advance(0.3);
    for (const provider of ["codex", "claude"]) {
      await view.input("/" + provider + "\t");
      for (const hidden of [true, false]) {
        if (hidden) {
          await view.input("\x7f");
          await view.advance(0.4);
          for (let i = 0; i < 30; i++) {
            await view.input("\x7f");
            await view.advance(0.05);
          }
          await view.advance(2);
        } else {
          // A removed default waits under its agent in Add agent: down to
          // the strip, into its list, and Enter adds it back.
          await view.input("\x1b[B\r");
          const label = provider === "codex" ? "Codex" : "Claude Code",
            rows = screen_text(view.state.data, 100, 30);
          this.assertTrue(
            rows.some(line => line.includes(`› + ${label} `) && line.includes("Removed")),
            rows.join("\n"),
          );
          await view.input("\r");
        }
        this.assertFalse(view.state.detached);
        this.assertIn("Manage agents", view.state.data);
        const session = await this.session();
        this.assertEqual(session.agent_hidden[provider], hidden);
        this.assertEqual(session.panes.length, 0);
      }
      await view.input("\t" + "\x7f".repeat(provider.length));
    }
    await view.input("\x1b[D");
    await view.advance(0.3);
    await view.input("t");
    await this.terminal(view);
  }
  async test_dismissing_fresh_launcher_with_mouse_opens_a_terminal() {
    const view = await this.start();
    await view.input("\x1b[<0;100;1M\x1b[<0;100;1m");
    await this.terminal(view);
  }
  async test_explicit_detach_from_fresh_launcher_does_not_open_a_terminal() {
    const view = await this.start();
    await view.action("detach");
    this.assertTrue(view.state.detached);
    this.assertEqual((await this.session()).panes.length, 0);
  }
}
registerCase("Fresh onboarding", Onboarding);
