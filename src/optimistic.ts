import * as docking from "./docking";
import * as protocol from "./protocol";
import { Order, Pins, live, type Target } from "./agent_order";
import { moveBefore } from "./workspace";
import type { Runtime, Workspace } from "./mirror";

/** A change to the mirror showing a command's result before its daemon
 * answers. It's made again after every snapshot until the reply, so it must
 * come out the same whether or not the daemon has made it already. */
export type Edit = (runtime: Runtime) => void;

/** The edit showing `command`, made with the daemon's own steps; null when
 * only the daemon's answer can show it. */
export function edit(command: protocol.CommandInput): Edit | null {
  const request = protocol.command(command as protocol.Command);
  switch (request.op) {
    case "agent.move":
    case "agent.place": {
      const { workspace, target, before } = request.payload,
        list = request.op === "agent.move" ? "agent_order" : "activity_order";
      return runtime => {
        const ws = find(runtime, workspace),
          order = Order.restore(ws[list]);
        order.move(agents(runtime, ws), target, before ?? null);
        ws[list] = order.items;
      };
    }
    case "agent.pin": {
      const { workspace, target, before, pinned } = request.payload;
      return runtime => {
        const ws = find(runtime, workspace),
          pins = Pins.restore(ws.pinned_agents);
        if (pinned === false) pins.unpin(agents(runtime, ws), target);
        else pins.pin(agents(runtime, ws), target, before ?? null);
        ws.pinned_agents = pins.items;
      };
    }
    case "workspace.move": {
      const { target, before } = request.payload;
      return runtime => moveBefore(runtime.workspaces.items, target, before);
    }
    case "layout.dock": {
      const q = request.payload;
      return runtime => {
        const ws = find(runtime, q.workspace);
        // Docked, or changed by something else: the daemon's layout stands.
        if (ws.model.revision !== q.expected) return;
        // A new tab or shell gets its id from the daemon, which may differ.
        const plan = docking.arrange(ws.model, q.source, q.drop, q.focus, unused(runtime));
        plan.model.revision = BigInt.asUintN(64, q.expected + 1n);
        ws.model = plan.model;
      };
    }
    default:
      return null;
  }
}
/** An id past every pane and tab shown. The daemon numbers them across
 * workspaces, so one only this workspace lacks may be another's pane. */
function unused(runtime: Runtime): number {
  return Math.max(...runtime.workspaces.items.map(ws => docking.nextId(ws.model)), ...runtime.panes.map(p => p.id + 1));
}
function find(runtime: Runtime, id: number): Workspace {
  const ws = runtime.workspaces.items.find(ws => ws.id === id);
  if (!ws) throw Error("NoWorkspace");
  return ws;
}
function agents(runtime: Runtime, ws: Workspace): Target[] {
  return live(
    ws.model,
    runtime.panes,
    runtime.sessions.filter(s => s.workspace === ws.id),
  );
}
