//! A viewer's private projection of shared session organization and pane
//! surfaces. These terminals are framebuffers: no child process or PTY is
//! created here. Mirrors mirror.zig.
import { Terminal as NativeTerminal } from "./pane/terminal";
import * as viewerNative from "./viewer_native";
import { Model, max_panes, max_workspaces } from "./layout";
import { stringify } from "./json";
import * as protocol from "./protocol";
import * as viewerVersion from "./viewer_version";
import { commandEntry } from "./agent_launcher";
import type { Entry as CommandEntry } from "./launch/command";
import { status as setupStatus, type Status as SetupStatus } from "./corgi_setup";
import { status as shellStatus } from "./shell_picker";
import type { ShellStatus } from "./launch/command";
import type { Provider } from "./providers";
import { type Conversation, conversation, usageView } from "./subagent_tooltip";
import { View as UsageView } from "./usage/live";
import * as errors from "./errors";
import { removal as worktreeRemoval, type Removal, type Snapshot as Worktrees } from "./worktrees";

export interface Transport {
  socket?: string;
  request(op: string, fields?: Record<string, unknown>): Promise<any>;
}
/** An RPC call that throws the daemon's error name, as Zig's `call` does. */
export async function call(conn: Transport, op: string, fields: Record<string, unknown> = {}): Promise<any> {
  const reply = await conn.request(op, fields);
  if (reply && typeof reply === "object" && "err" in reply && reply.err) throw Error(reply.err);
  // Before the payload, whose shape may differ between viewer protocols.
  if (protocol.check(op) === "viewer") viewerVersion.require(reply);
  return reply;
}
export interface Stamp {
  identity: number | bigint;
  revision: number | bigint;
  offset: number | null;
}
export interface Link {
  row: number;
  start: number;
  end: number;
  uri: string;
  id: number | bigint;
}
interface Selection {
  x: number;
  y: number;
  end_x: number;
  end_y: number;
}

export class Terminal {
  inner: NativeTerminal;
  offset: number | null = null;
  bottom = 0;
  selection: Selection | null = null;
  holding_selection = false;
  known: Stamp | null = null;
  render_dirty = true;
  /** Bytes for the program, sent with the next sync. */
  pending: number[] = [];
  private links: Link[] = [];

  constructor(
    public conn: Transport,
    public id: number,
    cols: number,
    rows: number,
  ) {
    this.inner = NativeTerminal.create(Math.max(1, cols), Math.max(1, rows));
  }
  get handle() {
    return this.inner.handle;
  }
  hyperlinks(): Link[] {
    return this.links;
  }
  updateRender(): void {
    if (!this.render_dirty) return;
    viewerNative.updateRender(this.handle);
    this.links = this.inner.hyperlinks() as Link[];
    this.render_dirty = false;
  }
  destroy(): void {
    this.inner.destroy();
    this.pending = [];
  }
  atBottom(): boolean {
    return this.offset === null;
  }
  clearSelection(): void {
    this.selection = null;
    this.holding_selection = false;
    this.inner.clearSelection();
    this.render_dirty = true;
  }
  scrollViewport(scroll: "bottom" | "top" | { row: number } | { delta: number }): void {
    if (scroll === "bottom") this.offset = null;
    else if (scroll === "top") this.offset = 0;
    else if ("row" in scroll) this.offset = Math.min(scroll.row, this.bottom);
    else this.offset = Math.min(Math.max((this.offset ?? this.bottom) + scroll.delta, 0), this.bottom);
    if (this.offset === this.bottom) this.offset = null;
    try {
      this.clearSelection();
    } catch {}
  }
  select(x: number, y: number, end_x: number, end_y: number): void {
    this.selection = { x, y, end_x, end_y };
    this.inner.select(x, y, end_x, end_y);
    this.render_dirty = true;
  }
  selectedText(): string {
    return this.inner.selectedText();
  }
  async search(needle: string, skip: number): Promise<boolean> {
    const response = await call(this.conn, "viewer.search", { pane: this.id, needle, skip });
    if (response.offset === null || response.offset === undefined) return false;
    this.offset = Number(response.offset);
    // A match on the current viewport still needs its selection applied.
    this.known = null;
    if (response.match)
      this.selection = {
        x: response.match.x,
        y: response.match.y,
        end_x: response.match.end_x,
        end_y: response.match.end_y,
      };
    return true;
  }
  send(bytes: string | Uint8Array | number[]): void {
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    if (this.pending.length + data.length > 1024 * 1024) throw Error("InputBackpressure");
    for (const byte of data) this.pending.push(byte);
  }
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const data = Buffer.from(this.pending).toString();
    try {
      await call(this.conn, "session.command", { command: { "pane.input": { target: this.id, data } } });
    } catch (error) {
      if (!errors.is(error, "NoPane")) throw error;
    }
    this.pending = [];
  }
  receive(view: any): void {
    // Keep the displayed text stable for the entire mouse gesture. The
    // runtime continues collecting output; release resumes the live surface.
    if (this.holding_selection) return;
    const frame = view.surface;
    if (!frame || frame.cols === 0 || frame.rows === 0) return;
    this.render_dirty = true;
    viewerNative.receive(this.handle, stringify(view));
    this.inner.cols = frame.cols;
    this.inner.rows = frame.rows;
    this.bottom = Number(view.bottom ?? 0);
    if (this.offset !== null) this.offset = Number(view.offset ?? 0);
    const sel = this.selection;
    if (sel) this.inner.select(sel.x, sel.y, sel.end_x, sel.end_y);
    this.updateRender();
    // Only acknowledge surfaces actually installed. A mouse gesture may
    // hold the old display while the daemon continues collecting output.
    this.known = view.stamp ?? null;
  }
  /** Whether its program asked for mouse events. */
  mouseEvents(): boolean {
    return viewerNative.mouseEvents(this.handle);
  }
  bracketedPaste(): boolean {
    return viewerNative.bracketedPaste(this.handle);
  }
  pasteEvents(): boolean {
    return viewerNative.pasteEvents(this.handle);
  }
  /** The render state's cursor in the viewport, when visible. */
  cursor(): { x: number; y: number } | null {
    return viewerNative.cursor(this.handle, true);
  }
  /** The render state's cursor in the viewport, shown or not. */
  caret(): { x: number; y: number } | null {
    return viewerNative.cursor(this.handle, false);
  }
  rows(
    pane: number,
    x: number,
    y: number,
    w: number,
    h: number,
    dimmed: boolean,
    hovered: number | bigint | null,
  ): string {
    return viewerNative.rows(this.handle, pane, x, y, w, h, dimmed, hovered);
  }
}

export interface Observation {
  completed: number;
  read: number;
  [key: string]: unknown;
}
export function unread(o: Observation | undefined): boolean {
  return !!o && Number(o.completed ?? 0) > Number(o.read ?? 0);
}
export function acknowledge(o: Observation, through: number): void {
  o.read = Math.max(Number(o.read ?? 0), Math.min(through, Number(o.completed ?? 0)));
}
/** protocol.zig's `Agent`, as the snapshot sends it. */
export interface Agent {
  conversation: number;
  subagents: { running: number; blocked: number; waiting: boolean };
  name: string;
  observation: Observation;
  recent_activity: string;
  changed_at: number;
  working_since: number;
  provider: Provider | null;
  state: string;
  attention: "none" | "finished" | "needs_input";
  session: string;
  transcript: string;
  activity: string;
  cwd: string;
  tool_active: boolean;
  compacting: boolean;
  paused: boolean;
}
export function agent(value: any = {}): Agent {
  return {
    conversation: Number(value.conversation ?? 0),
    subagents: {
      running: Number(value.subagents?.running ?? 0),
      blocked: Number(value.subagents?.blocked ?? 0),
      waiting: value.subagents?.waiting === true,
    },
    name: value.name ?? "",
    observation: {
      ...(value.observation ?? {}),
      completed: Number(value.observation?.completed ?? 0),
      read: Number(value.observation?.read ?? 0),
    },
    recent_activity: value.recent_activity ?? "",
    changed_at: Number(value.changed_at ?? 0),
    working_since: Number(value.working_since ?? 0),
    provider: value.provider ?? null,
    state: value.state ?? "unknown",
    attention: value.attention ?? "none",
    session: value.session ?? "",
    transcript: value.transcript ?? "",
    activity: value.activity ?? "",
    cwd: value.cwd ?? "",
    tool_active: value.tool_active === true,
    compacting: value.compacting === true,
    paused: value.paused === true,
  };
}
export function providerName(a: Agent): string {
  return a.provider ?? "agent";
}
export interface Pane {
  binding: number | bigint;
  id: number;
  label: string;
  cwd: string;
  agent: Agent;
  terminal: Terminal;
  /** The command a reopened agent runs while its old screen shows, or a
   * dormant one will run. */
  restoring: string;
  /** Its command forks, so the band says "Forking…". */
  forking: boolean;
  /** Nothing runs yet: focusing it starts `restoring` here. */
  dormant: boolean;
  /** When this viewer first saw it restoring, which its animation starts from. */
  restoring_since: number;
}
/** protocol.zig's `Workspace`, with its model parsed. */
export interface Workspace {
  id: number;
  name: string;
  custom_name: string;
  cwd: string;
  model: Model;
  agent_order: ({ pane: number } | { native: number })[];
  last_agent: Provider | null;
  closed_agents: number;
  git_commits: any[];
  git_ahead: number | null;
  worktrees: Worktrees | null;
  git_ref: any;
  git_push: { phase: "idle" | "pushing" | "succeeded" | "failed"; message: string };
  /** A worktree being removed, or the last one removed, while the daemon reports it. */
  worktree_removal: Removal | null;
  stats: any;
}
function workspace(value: any): Workspace {
  return {
    id: value.id,
    name: value.name ?? "",
    custom_name: value.custom_name ?? "",
    cwd: value.cwd ?? "",
    model: Model.fromData(value.model),
    agent_order: value.agent_order ?? [],
    last_agent: value.last_agent ?? null,
    closed_agents: Number(value.closed_agents ?? 0),
    git_commits: value.git_commits ?? [],
    git_ahead: value.git_ahead === null || value.git_ahead === undefined ? null : Number(value.git_ahead),
    worktrees: worktreeSnapshot(value.worktrees),
    git_ref: value.git_ref ?? {},
    git_push: { phase: value.git_push?.phase ?? "idle", message: value.git_push?.message ?? "" },
    worktree_removal: worktreeRemoval(value.worktree_removal),
    stats: { tools: 0, input: 0, output: 0, tokens_known: false, ...(value.stats ?? {}) },
  };
}
export function worktreeSnapshot(value: any): Worktrees | null {
  if (!value || !Array.isArray(value.entries)) return null;
  const count = (v: unknown): bigint | null => {
    if (typeof v !== "bigint" && typeof v !== "number" && typeof v !== "string") return null;
    try {
      const n = BigInt(v);
      return n >= 0n ? n : null;
    } catch {
      return null;
    }
  };
  return {
    common_dir: value.common_dir ?? "",
    base: value.base ? { ref: value.base.ref ?? "", name: value.base.name ?? "", head: value.base.head ?? "" } : null,
    stale: value.stale === true,
    entries: value.entries.map((e: any) => {
      const ahead = count(e.comparison?.ahead),
        behind = count(e.comparison?.behind);
      return {
        path: e.path ?? "",
        head: e.head ?? "",
        branch: e.branch ?? null,
        primary: e.primary === true,
        bare: e.bare === true,
        detached: e.detached === true,
        locked: e.locked ?? null,
        prunable: e.prunable ?? null,
        available: e.available === true,
        comparison: ahead === null || behind === null ? null : { ahead, behind },
        changes: e.changes
          ? {
              total: Number(e.changes.total ?? 0),
              staged: Number(e.changes.staged ?? 0),
              modified: Number(e.changes.modified ?? 0),
              untracked: Number(e.changes.untracked ?? 0),
              conflicted: Number(e.changes.conflicted ?? 0),
            }
          : null,
        stale: e.stale === true,
      };
    }),
    agents: (value.agents ?? []).flatMap((a: any) => {
      const target =
        a.target?.pane !== undefined
          ? { pane: Number(a.target.pane) }
          : a.target?.native !== undefined
            ? { native: Number(a.target.native) }
            : null;
      return target
        ? [{ target, path: a.path ?? "", source: a.source === "write" ? "write" : "cwd", stale: a.stale === true }]
        : [];
    }),
  };
}
export function statsAny(stats: any): boolean {
  return Object.values(stats ?? {}).some(v => v !== 0 && v !== false && v !== null && v !== undefined && v !== "0");
}
export interface Native {
  agent: Agent | null;
  observation: Observation;
  id: number;
  workspace: number;
  provider: Provider;
  cwd: string;
  ready: boolean;
  exited: boolean;
  state: string;
  attention: "none" | "finished" | "needs_input";
  tool_active: boolean;
  compacting: boolean;
}
function native(value: any): Native {
  return {
    agent: value.agent ? agent(value.agent) : null,
    observation: {
      ...(value.observation ?? {}),
      completed: Number(value.observation?.completed ?? 0),
      read: Number(value.observation?.read ?? 0),
    },
    id: value.id,
    workspace: value.workspace,
    provider: value.provider,
    cwd: value.cwd ?? "",
    ready: value.ready === true,
    exited: value.exited === true,
    state: value.state ?? "unknown",
    attention: value.attention ?? "none",
    tool_active: value.tool_active === true,
    compacting: value.compacting === true,
  };
}
export class Workspaces {
  items: Workspace[] = [];
  index(id: number): number | null {
    const i = this.items.findIndex(ws => ws.id === id);
    return i < 0 ? null : i;
  }
  owner(pane: number): Workspace | null {
    return this.items.find(ws => ws.model.tabForPane(pane) !== null) ?? null;
  }
}

export class Runtime {
  snapshot: any = null;
  snapshot_hash: number | bigint | null = null;
  workspaces = new Workspaces();
  panes: Pane[] = [];
  sessions: Native[] = [];
  conversations: Conversation[] = [];
  system_model = "";
  system_model_name = "";
  release_version = "";
  release_commit = "";
  staged_version = "";
  inference: SetupStatus = setupStatus();
  shell: ShellStatus = shellStatus();
  system_working = false;
  smart_links = true;
  system_usage = new UsageView();
  ports: any = { workspaces: [] };
  resources: any = { workspaces: [] };
  resources_hash: number | bigint | null = null;
  last_agent: Provider = "codex";
  agent_yolo = { codex: false, claude: false };
  agent_hidden = { codex: false, claude: false };
  agent_commands: CommandEntry[] = Array.from({ length: 6 }, () => commandEntry());
  pane(id: number): Pane | null {
    return this.panes.find(p => p.id === id) ?? null;
  }
  destroy(): void {
    for (const p of this.panes) p.terminal.destroy();
    this.panes = [];
    this.snapshot = null;
  }
  receiveResources(value: any): void {
    this.resources = value ?? { workspaces: [] };
  }
  receive(conn: Transport, value: any): void {
    // Own the decoded snapshot. Metadata is used directly; only terminal
    // surfaces and interaction state survive independently between snapshots.
    const snapshot = value;
    const workspaces = snapshot?.workspaces ?? [];
    const infos = snapshot?.panes ?? [];
    if (workspaces.length === 0 || workspaces.length > max_workspaces || infos.length > max_panes)
      throw Error("InvalidSnapshot");
    const parsed = workspaces.map(workspace);
    const created: Terminal[] = [];
    const panes: Pane[] = [];
    const now = Date.now();
    try {
      for (const info of infos) {
        const previous = this.pane(info.id);
        let term = previous?.terminal;
        if (!term) {
          term = new Terminal(conn, info.id, info.cols, info.rows);
          created.push(term);
        }
        const was_restoring = previous ? previous.restoring.length > 0 && !previous.dormant : false;
        panes.push({
          id: info.id,
          binding: info.binding ?? 0,
          label: info.name ?? "",
          cwd: info.cwd ?? "",
          agent: agent(info.agent),
          terminal: term,
          restoring: info.restoring ?? "",
          forking: info.forking === true,
          dormant: info.dormant === true,
          restoring_since: was_restoring ? previous!.restoring_since : now,
        });
      }
    } catch (error) {
      for (const term of created) term.destroy();
      throw error;
    }
    for (const old of this.panes) if (!panes.some(p => p.id === old.id)) old.terminal.destroy();
    this.snapshot = snapshot;
    this.snapshot_hash = null;
    this.panes = panes;
    this.workspaces.items = parsed;
    this.sessions = (snapshot.native_sessions ?? []).map(native);
    this.conversations = (snapshot.conversations ?? []).map(conversation);
    this.system_model = snapshot.system_model ?? "";
    this.system_model_name = snapshot.system_model_name ?? "";
    this.release_version = snapshot.release_version ?? "";
    this.release_commit = snapshot.release_commit ?? "";
    this.staged_version = snapshot.staged_version ?? "";
    this.inference = setupStatus(snapshot.inference);
    this.shell = shellStatus(snapshot.shell);
    this.system_usage = usageView(snapshot.system_usage);
    this.system_working = snapshot.system_working === true;
    this.smart_links = snapshot.smart_links !== false;
    this.ports = snapshot.ports ?? { workspaces: [] };
    this.last_agent = snapshot.last_agent ?? "codex";
    this.agent_yolo = { codex: snapshot.agent_yolo?.codex === true, claude: snapshot.agent_yolo?.claude === true };
    this.agent_hidden = {
      codex: snapshot.agent_hidden?.codex === true,
      claude: snapshot.agent_hidden?.claude === true,
    };
    this.agent_commands = Array.from({ length: 6 }, (_, i) => commandEntry(snapshot.agent_commands?.[i]));
  }
}
