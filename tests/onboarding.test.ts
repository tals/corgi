/** A fresh install finishes onboarding with no workspace, on the button that makes one. */
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
    this.assertEqual((await this.session()).workspaces, []);
    await view.input("\r");
    this.assertIn("Bring your work along", view.state.data);
    if (mouse) await this.clickText(view, "S Skip import");
    else await view.input("s");
    this.assertFalse(view.state.detached);
    this.assertIn("Create workspace", view.state.data);
    this.assertNotIn("New terminal", view.state.data);
    const session = await this.session();
    this.assertEqual([session.workspaces, session.panes], [[], []]);
    this.assertTrue(
      JSON.parse(readFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"), "utf8")).onboarding_complete,
    );
    return view;
  }
  /** Creates the first workspace from the dialog the button opened, and types in its shell. */
  async terminal(view: Viewer) {
    this.assertIn("Folder", view.state.data);
    await view.input("\r");
    await this.until(async () => (await view.poll()).pane > 0);
    const session = await this.session();
    this.assertEqual(
      session.workspaces.map((w: any) => w.id),
      [1],
    );
    this.assertEqual(session.panes.length, 1);
    await view.input("printf 'CORGI_ONBOARD_%s\\n' READY\r");
    await this.until(async () => (await view.poll()).data.includes("CORGI_ONBOARD_READY"));
  }
  async test_keyboard_completion_leaves_the_create_workspace_button() {
    const view = await this.start(false);
    await view.input("\r");
    await this.terminal(view);
  }
  async test_mouse_completion_leaves_the_create_workspace_button() {
    const view = await this.start(true);
    await this.clickText(view, "Create workspace");
    await this.terminal(view);
  }
  async test_explicit_detach_after_onboarding_creates_nothing() {
    const view = await this.start();
    await view.action("detach");
    this.assertTrue(view.state.detached);
    const session = await this.session();
    this.assertEqual([session.workspaces, session.panes], [[], []]);
  }
}
registerCase("Fresh onboarding", Onboarding);
