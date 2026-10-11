//! Copy transactions spawn only new shells and roll back their own work.
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";
import { Runtime, Create } from "../runtime";
import { Model, max_panes, max_workspaces, Axis } from "../layout";
import { label } from "../pane/label";
import type { Source, Workspace, Pane } from "./catalog";
import * as tree from "./layout";
import * as herdr from "./herdr";
import * as tmux_resume from "./tmux_resume";
export type ImportWorkspace = Workspace;
export type Plan = {
  operation: bigint;
  source: Source;
  selected?: string[];
  workspaces: ImportWorkspace[];
  herdr_session: herdr.SourceSession | null;
};
export type Progress = {
  phase: "idle" | "copying" | "failed" | "complete";
  completed: number;
  total: number;
  workspace: number | null;
  message: string;
};
export class Job {
  plan: Plan | null = null;
  progress: Progress = {
    phase: "idle",
    completed: 0,
    total: 0,
    workspace: null,
    message: "",
  };
  index = 0;
  created: number[] = [];
  operation = 0n;
  get count() {
    return this.created.length;
  }
  busy() {
    return this.plan !== null;
  }
  stop() {
    this.plan = null;
  }
  start(plan: Plan): void {
    if (this.busy()) throw Error("ImportInProgress");
    const p = structuredClone(plan);
    if (!p.workspaces.length || p.workspaces.length > max_workspaces || (p.source === "herdr" && !p.herdr_session))
      throw Error("InvalidImport");
    let total = 0;
    for (const ws of p.workspaces) {
      for (const tab of ws.tabs) {
        if (!tab.panes.length || tab.panes.length > max_panes) throw Error("InvalidImport");
        if (tab.nodes?.length) tree.validate(tab.nodes, tab.panes.length);
        total += tab.panes.length;
      }
    }
    if (total > max_panes) throw Error("TooManyPanes");
    this.plan = p;
    this.operation = plan.operation;
    this.index = 0;
    this.created = [];
    this.progress = {
      phase: "copying",
      completed: 0,
      total,
      workspace: null,
      message: "Creating workspaces and shells",
    };
  }
  async tick(r: Runtime, defaults: Create): Promise<boolean> {
    const plan = this.plan;
    if (!plan) return false;
    const source = plan.workspaces[this.index];
    try {
      const id =
        plan.source === "herdr"
          ? await herdr.copy(r, plan.herdr_session!, [source.id], defaults)
          : await copy(r, source, plan.source, defaults);
      this.created.push(id);
      this.progress.workspace ??= id;
      this.progress.completed += source.tabs.reduce((n, t) => n + t.panes.length, 0);
      this.index++;
      if (this.index === plan.workspaces.length) {
        this.progress.phase = "complete";
        this.progress.message = "Copied successfully. Source processes are unchanged.";
        this.stop();
      }
    } catch (error) {
      for (const id of this.created) discard(r, id);
      this.progress.phase = "failed";
      this.progress.message = (error as Error).message;
      this.progress.completed = 0;
      this.stop();
    }
    return true;
  }
}
export function cmuxDirectory(path: string, fallback: string): string {
  for (const candidate of [path, fallback, process.env.HOME ?? "/", "/"]) {
    if (!isAbsolute(candidate)) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return "/";
}
function clear(model: Model, index: number) {
  const node = model.nodes[index];
  if (!node) return;
  if ("split" in node) {
    clear(model, node.split.first);
    clear(model, node.split.second);
  }
  model.nodes[index] = null;
}
export function geometry(model: Model, panes: Pane[], ids: number[], indices: number[]): number {
  if (indices.length === 1) return model.alloc({ pane: ids[indices[0]] });
  for (const axis of ["horizontal", "vertical"] as Axis[]) {
    const origin = (p: Pane) => (axis === "horizontal" ? p.x : p.y),
      size = (p: Pane) => (axis === "horizontal" ? p.w : p.h),
      min = Math.min(...indices.map(i => origin(panes[i]))),
      max = Math.max(...indices.map(i => origin(panes[i]) + size(panes[i])));
    for (const candidate of indices) {
      const cut = origin(panes[candidate]);
      if (cut <= min || cut >= max) continue;
      const left: number[] = [],
        right: number[] = [];
      let crosses = false;
      for (const i of indices) {
        const start = origin(panes[i]),
          end = start + size(panes[i]);
        if (end <= cut) left.push(i);
        else if (start >= cut) right.push(i);
        else {
          crosses = true;
          break;
        }
      }
      if (crosses || !left.length || !right.length) continue;
      const first = geometry(model, panes, ids, left),
        second = geometry(model, panes, ids, right);
      return model.alloc({
        split: {
          axis,
          first,
          second,
          ratio: Math.max(100, Math.min(900, Math.floor(((cut - min) * 1000) / (max - min)))),
        },
      });
    }
  }
  throw Error("UnsupportedSourceLayout");
}
export async function copy(
  r: Runtime,
  source: Omit<Workspace, "session" | "activity">,
  kind: Source,
  defaults: Create,
): Promise<number> {
  const dir =
      kind === "cmux"
        ? cmuxDirectory(source.cwd, process.env.HOME ?? "/")
        : isAbsolute(source.cwd)
          ? source.cwd
          : (process.env.HOME ?? "/"),
    wid = await r.workspaces.add(source.name, dir);
  try {
    for (const tab of source.tabs) {
      if (tab.panes.length > max_panes) throw Error("TooManyPanes");
      const ids: number[] = [];
      let first: number | null = null;
      for (const p of tab.panes) {
        const id = await r.create({
            ...defaults,
            workspace: wid,
            cwd: kind === "cmux" ? cmuxDirectory(p.cwd, dir) : isAbsolute(p.cwd) ? p.cwd : dir,
            title: tab.name,
            command: null,
            interactive_command: false,
            split: first === null ? null : { pane: first, axis: "horizontal" },
          }),
          terminal = r.pane(id)!.terminal;
        if (kind === "tmux") {
          tmux_resume.feed(terminal, p.history);
          tmux_resume.feed(terminal, p.screen);
          terminal.feed("\x1b[0m\r\n# Imported tmux output; new shell.\r\n");
          if (p.restart_command) {
            if (/[\x00-\x1f\x7f]/.test(p.restart_command)) throw Error("InvalidImport");
            terminal.feed("# Press Return to restart the command below.\r\n");
            terminal.prefill(p.restart_command);
          }
        }
        if (kind === "cmux") r.pane(id)!.label = label(p.name);
        ids.push(id);
        first ??= id;
        if (p.url) terminal.feed("\r\n# Imported browser link:\r\n# " + p.url.replace(/[\x00-\x1f\x7f]/g, "") + "\r\n");
      }
      if (tab.nodes?.length || (kind === "tmux" && tab.panes.length > 1)) {
        const ws = r.getWorkspace(wid),
          ti = ws.model.tabForPane(first!)!,
          model = Model.fromData(ws.model.toJSON());
        clear(model, model.tabs[ti].root);
        model.tabs[ti].root = tab.nodes?.length
          ? tree.install(model, tab.nodes, ids)
          : geometry(
              model,
              tab.panes,
              ids,
              ids.map((_, i) => i),
            );
        ws.model = model;
      }
    }
    r.changed();
    return wid;
  } catch (error) {
    discard(r, wid);
    throw error;
  }
}
export function discard(r: Runtime, wid: number): void {
  const index = r.workspaces.index(wid);
  if (index === null) return;
  const model = r.workspaces.items[index].model;
  for (let i = r.panes.length - 1; i >= 0; i--)
    if (model.tabForPane(r.panes[i].id) !== null) {
      const [p] = r.panes.splice(i, 1);
      r.stopShell(p.terminal);
      p.terminal.destroy();
    }
  r.workspaces.items.splice(index, 1);
  r.changed();
}
