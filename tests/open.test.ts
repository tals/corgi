/** The public `corgi open` command, from an outer terminal. */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Runtime, EXE } from "./runtime";
import { Pty, deadline, registerCase } from "./support";

class Open extends Runtime {
  autostart = false;
  project!: string;
  other!: string;
  async configure() {
    this.project = join(this.temp.name, "project");
    this.other = join(this.temp.name, "other");
    mkdirSync(this.project);
    mkdirSync(this.other);
    this.project = realpathSync(this.project);
    this.other = realpathSync(this.other);
  }
  async open(folder: string) {
    this.pty = await Pty.spawn([EXE, "open", folder], {
      env: this.env,
      cwd: this.temp.name,
      cols: 100,
      rows: 30,
    });
    await this.pty.waitFor("workspaces");
    const viewer = (await this.rpc({ op: "viewer.list" })).viewers[0];
    const state = await this.session();
    return {
      workspace: state.workspaces.find((w: any) => w.id === viewer.workspace),
      pane: state.panes.find((p: any) => p.id === viewer.pane),
    };
  }
  async detach() {
    this.pty.write("\x02q");
    this.assertEqual(await deadline(this.pty.proc.exited, 4000, "Corgi did not detach"), 0);
    await this.pty.close();
    this.pty = null;
  }
  async checkProject(folder: string) {
    const { workspace, pane } = await this.open(folder);
    this.assertEqual([workspace.name, workspace.cwd, pane.cwd], ["project", this.project, this.project]);
    this.assertEqual((await this.session()).workspaces.length, 1);
    this.assertEqual((await this.session()).panes.length, 1);
    this.pty.write("printf 'OPEN_%s:%s\\n' READY \"$PWD\"\r");
    await this.pty.waitFor("OPEN_READY:" + this.project);
    await this.detach();
    this.assertEqual((await this.session()).panes[0].pid, pane.pid);
  }
  async test_relative_folder_starts_daemon_and_shell() {
    await this.checkProject("project");
  }
  async test_absolute_folder_uses_waiting_daemon() {
    await this.run_cli("start");
    await this.checkProject(this.project);
  }
  async test_open_creates_and_reuses_workspaces_with_live_shells() {
    const first = await this.open(this.project);
    await this.detach();
    const second = await this.open(this.other);
    this.assertNotEqual(first.workspace.id, second.workspace.id);
    this.assertEqual([second.workspace.name, second.pane.cwd], ["other", this.other]);
    await this.detach();
    const reopened = await this.open("project");
    this.assertEqual(reopened.workspace.id, first.workspace.id);
    this.assertEqual(reopened.pane.pid, first.pane.pid);
    const state = await this.session();
    this.assertEqual(
      state.workspaces.map((w: any) => w.name),
      ["project", "other"],
    );
    this.assertEqual(state.panes.length, 2);
    this.assertTrue(state.panes.some((p: any) => p.pid === second.pane.pid));
    await this.detach();
  }
}
registerCase("Open", Open, { inherited: false });
