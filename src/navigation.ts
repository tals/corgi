//! Local workspace/tab/pane selection. Shared models contain no active or
//! zoom state. Mirrors navigation.zig.
import { Model, Selection, View as LayoutView, Rect, type Direction } from "./layout";
import { History as AgentHistory } from "./agent_navigation";
import type { Row as LauncherRow } from "./agent_launcher";
import type { Workspaces, Workspace } from "./mirror";
import type { Action } from "./action";
import type { CommandInput } from "./protocol";

interface Entry {
  id: number;
  value: Selection;
  agents: AgentHistory;
  /** The launcher row last left selected here. */
  launcher: LauncherRow | null;
  /** How far this workspace's own agent list is scrolled. */
  agent_offset: number;
}
const emptyEntry = (id: number): Entry => ({
  id,
  value: new Selection(),
  agents: new AgentHistory(),
  launcher: null,
  agent_offset: 0,
});
export interface Intent {
  edit: CommandInput | null;
  focus: number | null;
}

export class State {
  workspace_id = 0;
  entries: Entry[] = [];

  index(store: Workspaces): number {
    const i = store.index(this.workspace_id) ?? 0;
    this.workspace_id = store.items[i].id;
    return i;
  }
  current(store: Workspaces): Workspace {
    return store.items[this.index(store)];
  }
  tabs(store: Workspaces): Selection {
    return this.entry(store, this.current(store)).value;
  }
  /** Takes over a closed workspace's slot the first time `ws` needs one. */
  private entry(store: Workspaces, ws: Workspace): Entry {
    for (const e of this.entries)
      if (e.id === ws.id) {
        e.value.reconcile(ws.model);
        return e;
      }
    const e = emptyEntry(ws.id);
    e.value.reconcile(ws.model);
    const free = this.entries.findIndex(old => store.index(old.id) === null);
    if (free === -1) this.entries.push(e);
    else this.entries[free] = e;
    return e;
  }
  /** Workspace `ws`'s tabs as focusing pane `id` would leave them. */
  entering(store: Workspaces, ws: Workspace, id: number): Selection {
    const from = this.entry(store, ws).value;
    const s = new Selection();
    s.tabs = from.tabs.map(t => ({ ...t }));
    s.count = from.count;
    s.active = from.active;
    s.focus(ws.model, id);
    return s;
  }
  agentHistory(store: Workspaces): AgentHistory {
    return this.entry(store, this.current(store)).agents;
  }
  /** The current workspace's agent list scroll, read and written through. */
  agentOffset(store: Workspaces): { get(): number; set(value: number): void } {
    const e = this.entry(store, this.current(store));
    return {
      get: () => e.agent_offset,
      set: (value: number) => {
        e.agent_offset = value;
      },
    };
  }
  /** The launcher row this viewer last left selected in workspace `id`. */
  launcherRow(store: Workspaces, id: number): LauncherRow | null {
    const i = store.index(id);
    if (i === null) return null;
    return this.entry(store, store.items[i]).launcher;
  }
  rememberLauncherRow(store: Workspaces, id: number, row: LauncherRow): void {
    const i = store.index(id);
    if (i === null) return;
    this.entry(store, store.items[i]).launcher = row;
  }
  /** Resolve command shorthand once, before crossing the session seam.
   * `Controller.perform` routes only tab and pane actions here. */
  command(store: Workspaces, act: Action, area: Rect): Intent {
    const model = this.current(store).model;
    if (model.count === 0) throw Error("NoPane");
    const selected = this.tabs(store);
    const pane = selected.tab().focus;
    const tab = model.tabs[selected.active].id;
    switch (act.name) {
      case "rename":
        return { edit: { "tab.rename": { target: tab, name: act.value as string } }, focus: null };
      case "resize":
        return { edit: { "split.resize": { target: pane, direction: act.value as Direction } }, focus: null };
      case "focus":
      case "swap": {
        const other = new LayoutView(model, selected).neighbor(act.value as any, area);
        if (other === null) return { edit: null, focus: null };
        return act.name === "focus"
          ? { edit: null, focus: other }
          : { edit: { "pane.swap": { target: pane, other } }, focus: null };
      }
      case "move-tab":
        return {
          edit: moveTab(
            model,
            tab,
            act.value === "left" ? Math.max(0, selected.active - 1) : Math.min(selected.active + 2, model.count),
          ),
          focus: null,
        };
      case "break":
        return "pane" in model.nodes[model.tabs[selected.active].root]!
          ? { edit: null, focus: null }
          : { edit: { "pane.move": { target: pane, destination: { new_tab: "" } } }, focus: pane };
      case "next":
      case "prev":
        return {
          edit: null,
          focus: selected.tabs[(selected.active + (act.name === "next" ? 1 : model.count - 1)) % model.count].focus,
        };
      case "tab":
      case "join": {
        const number = Number(act.value);
        if (number === 0 || number > model.count) throw Error("NoTab");
        const tab_index = number - 1;
        const target = selected.tabs[tab_index].focus;
        if (act.name === "join") {
          if (tab_index === selected.active) throw Error("NoTab");
          return {
            edit: { "pane.move": { target: pane, destination: { beside: { other: target, direction: "right" } } } },
            focus: pane,
          };
        }
        return { edit: null, focus: target };
      }
      default:
        throw Error("unreachable");
    }
  }
}

export function moveTab(model: Model, id: number, gap: number): CommandInput | null {
  if (gap > model.count || model.count === 0) return null;
  const other = model.tabs[gap === model.count ? gap - 1 : gap].id;
  if (id === other) return null;
  return { "tab.move": { target: id, destination: gap === model.count ? { after: other } : { before: other } } };
}
