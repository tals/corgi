import { Controller } from "../controller";
import { transport } from "./transport";

/** An attached `cols` × `rows` viewer whose daemon refuses every request. */
export function attached(cols: number, rows: number): Controller {
  const view = new Controller({
    request: transport(async () => {
      throw Error("UnexpectedRequest");
    }).request,
  });
  view.width = cols;
  view.height = rows;
  view.input_state.attached = true;
  return view;
}
/** A snapshot of workspace 1 showing pane 1 as its one tab, each with the fields given. */
export function onePane(workspace: object = {}, pane: object = {}) {
  return {
    workspaces: [
      {
        id: 1,
        name: "test",
        cwd: "/tmp",
        model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 },
        ...workspace,
      },
    ],
    panes: [
      {
        id: 1,
        workspace: 1,
        tab: 1,
        cols: 80,
        rows: 29,
        agent: { provider: null, attention: "none", observation: { completed: 0, read: 0 } },
        ...pane,
      },
    ],
    conversations: [],
    headless_sessions: [],
  };
}
/** An SGR mouse report of `button` at the zero-based cell `x`, `y`, pressed or released. */
export function mouse(button: number, x: number, y: number, release = false): Buffer {
  return Buffer.from(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
}
