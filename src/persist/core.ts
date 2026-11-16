//! Version-one process continuity. Keep this contract independent of metadata schemas.
import { isAbsolute } from "node:path";
import type { Runtime } from "../runtime";
import { ResumeHint } from "../resume_hint";
import * as checkpoint from "./checkpoint";
import * as json from "../json";
import * as errors from "../errors";
import * as layout from "../layout";

export type Screen = {
  cols: number;
  rows: number;
  data: string;
  pid: number;
  title_pid: number;
  fd: number;
  exited: boolean;
  exit_status: number;
  runs_command: boolean;
  initial_input: string | null;
  pending: string;
};
export type Pane = {
  id: number;
  workspace: number;
  cwd: string;
  label: string;
  screen: Screen;
  dormant: boolean;
  manual_resume: boolean;
  command: string | null;
};
export type Core = {
  live: boolean;
  saved_at: number;
  next_workspace: number;
  next_pane: number;
  workspaces: { id: number; name: string; cwd: string }[];
  panes: Pane[];
};
export function capture(runtime: Runtime, saved: ReturnType<typeof checkpoint.capture>): Core {
  return {
    live: saved.live,
    saved_at: saved.saved_at,
    next_workspace: saved.next_workspace,
    next_pane: saved.next_pane,
    workspaces: saved.workspaces.map(w => ({ id: w.id, name: w.name, cwd: w.cwd })),
    panes: saved.panes.map(p => {
      const pane = runtime.pane(p.id)!;
      return {
        id: p.id,
        workspace: runtime.workspaces.owner(p.id)!.id,
        cwd: p.cwd,
        label: p.label,
        screen: { ...p.screen, pending: p.screen.pending ?? "" },
        dormant: p.dormant,
        manual_resume: p.manual_resume,
        command: pane.resume_hint.args()
          ? pane.resume_hint.command()
          : (pane.manual_command ?? pane.launch?.command ?? null),
      };
    }),
  };
}
/** Extract the fixed core after the historical checkpoint revisions have run. */
export function fromCheckpoint(value: unknown): Core {
  try {
    const saved = json.object(value),
      workspaces = array(saved.workspaces).map(value => json.object(value)),
      owners = new Map<number, Record<string, any>>();
    for (const workspace of workspaces)
      for (const node of layout.Model.fromData(workspace.model).nodes)
        if (node && "pane" in node) {
          if (owners.has(node.pane)) throw Error("InvalidHandoffCore");
          owners.set(node.pane, workspace);
        }
    return decode({
      live: saved.live,
      saved_at: saved.saved_at,
      next_workspace: saved.next_workspace,
      next_pane: saved.next_pane,
      workspaces,
      panes: array(saved.panes).map(value => {
        const pane = json.object(value),
          screen = json.object(pane.screen),
          workspace = owners.get(pane.id),
          hint = checkpoint.hydrate(new ResumeHint(), pane.resume_hint),
          manual = pane.manual_resume === true || workspace?.archived === true;
        return {
          id: pane.id,
          workspace: workspace?.id,
          cwd: pane.cwd,
          label: pane.label ?? "",
          dormant: pane.dormant === true,
          manual_resume: manual,
          command: hint.args()
            ? hint.command()
            : ((manual && typeof pane.manual_command === "string" ? pane.manual_command : null) ??
              pane.launch?.command ??
              null),
          screen: {
            cols: screen.cols,
            rows: screen.rows,
            data: screen.data,
            pid: saved.live ? (screen.pid ?? -1) : -1,
            title_pid: saved.live ? (screen.title_pid ?? 0) : 0,
            fd: saved.live ? (screen.fd ?? -1) : -1,
            exited: screen.exited ?? true,
            exit_status: screen.exit_status ?? 0,
            runs_command: screen.runs_command ?? false,
            initial_input: saved.live ? (screen.initial_input ?? null) : null,
            pending: saved.live ? (screen.pending ?? "") : "",
          },
        };
      }),
    });
  } catch (error) {
    if (errors.is(error, "InvalidHandoffCore")) throw new checkpoint.Invalid("invalid terminal core");
    throw error;
  }
}

function integer(value: unknown, min: number, max = 0xffffffff): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw Error("InvalidHandoffCore");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw Error("InvalidHandoffCore");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw Error("InvalidHandoffCore");
  return value;
}
function directory(value: unknown): string {
  const path = string(value);
  if (!isAbsolute(path) || path.includes("\0")) throw Error("InvalidHandoffCore");
  return path;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("InvalidHandoffCore");
  return value;
}
export function decode(value: unknown): Core {
  const v = json.object(value),
    live = boolean(v.live),
    next_workspace = integer(v.next_workspace, 1),
    next_pane = integer(v.next_pane, 1),
    workspaces = array(v.workspaces).map(value => {
      const w = json.object(value),
        name = string(w.name);
      if (!name.length) throw Error("InvalidHandoffCore");
      return { id: integer(w.id, 1, next_workspace - 1), name, cwd: directory(w.cwd) };
    }),
    workspace_ids = new Set(workspaces.map(w => w.id)),
    panes = array(v.panes).map(value => {
      const p = json.object(value),
        s = json.object(p.screen),
        workspace = integer(p.workspace, 1);
      if (!workspace_ids.has(workspace)) throw Error("InvalidHandoffCore");
      const screen: Screen = {
        cols: integer(s.cols, 1, 500),
        rows: integer(s.rows, 1, 200),
        data: string(s.data),
        pid: integer(s.pid, -1, 0x7fffffff),
        fd: integer(s.fd, -1, 0x7fffffff),
        title_pid: integer(s.title_pid, 0, 0x7fffffff),
        exited: boolean(s.exited),
        exit_status: integer(s.exit_status, 0),
        runs_command: boolean(s.runs_command),
        initial_input: s.initial_input === null ? null : string(s.initial_input),
        pending: string(s.pending),
      };
      if (!live && (screen.fd !== -1 || screen.pid !== -1 || screen.pending !== "")) throw Error("InvalidHandoffCore");
      return {
        id: integer(p.id, 1, next_pane - 1),
        workspace,
        cwd: directory(p.cwd),
        label: string(p.label),
        screen,
        dormant: boolean(p.dormant),
        manual_resume: boolean(p.manual_resume),
        command: p.command === null ? null : string(p.command),
      };
    });
  if (workspace_ids.size !== workspaces.length || new Set(panes.map(p => p.id)).size !== panes.length)
    throw Error("InvalidHandoffCore");
  const handles = panes.map(p => p.screen.fd).filter(fd => fd >= 0);
  if (new Set(handles).size !== handles.length) throw Error("InvalidHandoffCore");
  return {
    live,
    saved_at: integer(v.saved_at, 0, Number.MAX_SAFE_INTEGER),
    next_workspace,
    next_pane,
    workspaces,
    panes,
  };
}
/** Metadata may refine presentation, but cannot remove or replace a core process. */
export function restore(core: Core, metadata: unknown): ReturnType<typeof checkpoint.capture> {
  const saved = metadata == null ? {} : json.object(metadata),
    panes = new Map((saved.panes ?? []).map((p: { id: number }) => [p.id, p])),
    workspaces = new Map((saved.workspaces ?? []).map((w: { id: number }) => [w.id, w]));
  return {
    ...saved,
    version: checkpoint.version,
    live: core.live,
    saved_at: core.saved_at,
    next_workspace: core.next_workspace,
    next_pane: core.next_pane,
    next_session: saved.next_session ?? 1,
    next_conversation: saved.next_conversation ?? 1,
    revision: saved.revision ?? 0,
    closed: saved.closed ?? [],
    sessions: saved.sessions ?? [],
    conversations: saved.conversations ?? [],
    workspaces: core.workspaces.map(w => {
      const extra = json.object(workspaces.get(w.id) ?? {}),
        members = core.panes.filter(p => p.workspace === w.id);
      let model;
      try {
        model = layout.Model.fromData(extra.model);
        const ids = model.nodes.flatMap(node => (node && "pane" in node ? [node.pane] : []));
        if (
          ids.length !== members.length ||
          members.some(p => !ids.includes(p.id)) ||
          model.tabs.some(t => t.id >= core.next_pane)
        )
          model = undefined;
      } catch {}
      return {
        ...extra,
        ...w,
        model: model ?? {
          nodes: members.map(p => ({ pane: p.id })),
          tabs: members.map((p, root) => ({ id: p.id, root, title: layout.boundLabel(p.label, true) })),
          revision: 0,
        },
      };
    }),
    panes: core.panes.map(p => {
      const extra = json.object(panes.get(p.id) ?? {});
      let launch = extra.launch ?? null,
        resume_hint = extra.resume_hint ?? {};
      if (p.command !== null) {
        const hint = checkpoint.hydrate(new ResumeHint(), resume_hint);
        // Only a matching hint may supply the protected resume arguments.
        if (hint.args() === null || hint.command() !== p.command) {
          launch = { command: p.command };
          resume_hint = {};
        }
      }
      return {
        binding: {},
        ...extra,
        launch,
        resume_hint,
        manual_command: p.command,
        id: p.id,
        cwd: p.cwd,
        label: p.label,
        screen: p.screen,
        dormant: p.dormant,
        manual_resume: p.manual_resume,
      };
    }),
  } as ReturnType<typeof checkpoint.capture>;
}
