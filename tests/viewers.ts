import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";

/** Shared isolated daemon and viewer fixture for sidebar, split and selection scenarios. */
export class Viewers extends Runtime {
  async newViewer(cols = 100, rows = 30) {
    return Viewer.create(this, cols, rows);
  }
  async new(command = "sleep 60", title = "") {
    const ws = (await this.session()).workspaces[0].id;
    return (
      await this.command("pane.create", {
        workspace: ws,
        cwd: this.temp.name,
        command,
        title,
      })
    ).pane;
  }
  async geometry() {
    return Object.fromEntries(
      (await this.session()).panes.map((p: any) => [p.id, [p.cols, p.rows]]),
    );
  }
  async mark_agent(pane: number, name: string) {
    await this.command("pane.rename", { target: pane, name });
    await this.rpc({
      op: "hook",
      pane,
      provider: "claude",
      seq: 1,
      event: { hook_event_name: "SessionStart", session_id: String(pane) },
    });
  }
}
