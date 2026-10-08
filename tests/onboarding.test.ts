/** Fresh viewers finish onboarding before any pane has been created. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase } from "./support";

class Onboarding extends Runtime {
  async configure() {
    writeFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"),
      JSON.stringify({ onboarding_complete: false }));
  }
  async clickText(view: Viewer, label: string) {
    const rows = screen_text(view.state.data, 100, 30);
    const y = rows.findIndex(row => row.includes(label));
    this.assertTrue(y >= 0, `Missing ${label}`);
    const x = rows[y].indexOf(label);
    return view.input(`\x1b[<0;${x + 2};${y + 1}M\x1b[<0;${x + 2};${y + 1}m`);
  }
  async finish(mouse: boolean) {
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
    this.assertTrue(JSON.parse(readFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"), "utf8")).onboarding_complete);
    await this.clickText(view, "New terminal");
    this.assertFalse(view.state.detached);
    this.assertTrue(view.state.pane > 0);
    await view.input("printf 'CORGI_ONBOARD_%s\\n' READY\r");
    await this.until(async () => (await view.poll()).data.includes("CORGI_ONBOARD_READY"));
  }
  async test_keyboard_completion_opens_launcher_and_runs_terminal() { await this.finish(false); }
  async test_mouse_completion_opens_launcher_and_runs_terminal() { await this.finish(true); }
}
registerCase("Fresh onboarding", Onboarding);
