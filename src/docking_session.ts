import * as docking from "./docking";
import * as layout from "./layout";
import type { Runtime } from "./runtime";
import type { Context, Result } from "./session";
import type { CommandPayloads } from "./protocol";

type Saved = { model: layout.Model; focus: number };
type History = { revision: bigint; focus: number; undo: Saved[]; redo: Saved[] };
// Layout history belongs to this viewer and this daemon lifetime, never recovery.
const histories = new WeakMap<Runtime, Map<string, History>>();
function history(r: Runtime, workspace: number, viewer: number): History {
  let all = histories.get(r);
  if (!all) histories.set(r, (all = new Map()));
  const key = `${viewer}:${workspace}`;
  let found = all.get(key);
  if (!found) {
    if (all.size >= 128) all.delete(all.keys().next().value!);
    all.set(key, (found = { revision: -1n, focus: 0, undo: [], redo: [] }));
  }
  return found;
}
function result(r: Runtime, workspace: number, pane: number): Result {
  const ws = r.getWorkspace(workspace);
  return { workspace, pane, tab: ws.model.tabs[ws.model.tabForPane(pane)!].id };
}
export async function dock(r: Runtime, ctx: Context, q: CommandPayloads["layout.dock"]): Promise<Result> {
  const ws = r.getWorkspace(q.workspace);
  if (ws.model.revision !== q.expected) throw Error("StaleLayout");
  if (ws.model.findNode(q.selected) === null) throw Error("InvalidDestination");
  const before = docking.clone(ws.model);
  let detached: layout.Tab | null = null;
  const plan = docking.arrange(ws.model, q.source, q.drop, q.focus, r.workspaces.next_pane_id);
  if (q.drop.kind === "beside" && !docking.fits(plan, new layout.Rect(0, 0, q.cols, q.rows))) throw Error("TooSmall");
  if (plan.shell !== null) {
    const from = r.pane(q.focus);
    if (!from || r.workspaces.owner(from.id) !== ws) throw Error("InvalidDestination");
    from.refreshCwd();
    const rect = docking
      .view(plan)
      .placements(new layout.Rect(0, 0, q.cols, q.rows))
      .find(p => p.id === plan.shell)!.rect;
    await r.create(
      { workspace: ws.id, cwd: from.cwd || ws.cwd, cols: rect.w, rows: rect.h, ...ctx },
      { model: plan.model, pane: plan.shell, expected: q.expected },
    );
    // Undo changes the arrangement, never kills a shell that may now be busy.
    const root = before.alloc({ pane: plan.shell });
    detached = new layout.Tab(r.workspaces.next_pane_id++, root);
    before.tabs.push(detached);
    before.count++;
  } else {
    plan.model.revision = BigInt.asUintN(64, before.revision + 1n);
    ws.model = plan.model;
    r.workspaces.next_pane_id = Math.max(r.workspaces.next_pane_id, plan.model.next_id);
    r.changed();
  }
  const h = history(r, ws.id, q.viewer);
  if (h.revision !== before.revision) h.undo = [];
  if (detached && plan.shell !== null)
    for (const saved of h.undo) {
      saved.model.tabs.push(new layout.Tab(detached.id, saved.model.alloc({ pane: plan.shell })));
      saved.model.count++;
    }
  h.undo.push({ model: before, focus: q.selected });
  if (h.undo.length > 32) h.undo.shift();
  h.redo = [];
  h.revision = ws.model.revision;
  h.focus = plan.focus;
  return result(r, ws.id, plan.focus);
}
export function restore(r: Runtime, q: CommandPayloads["layout.history"]): Result {
  const ws = r.getWorkspace(q.workspace),
    h = history(r, ws.id, q.viewer);
  if (ws.model.revision !== q.expected || h.revision !== q.expected) throw Error("StaleLayout");
  const from = q.direction === "undo" ? h.undo : h.redo,
    to = q.direction === "undo" ? h.redo : h.undo;
  const saved = from.at(-1);
  if (!saved) throw Error("NoLayoutHistory");
  const ids = (model: layout.Model) => model.tabs.flatMap(t => docking.panes(model, t.root)).sort((a, b) => a - b);
  if (JSON.stringify(ids(saved.model)) !== JSON.stringify(ids(ws.model))) throw Error("StaleLayout");
  const next = docking.clone(saved.model);
  next.next_id = r.workspaces.next_pane_id;
  next.revision = BigInt.asUintN(64, ws.model.revision + 1n);
  to.push({ model: docking.clone(ws.model), focus: h.focus });
  from.pop();
  ws.model = next;
  h.revision = next.revision;
  h.focus = saved.focus;
  r.changed();
  return result(r, ws.id, saved.focus);
}
