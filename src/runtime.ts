import * as clock from "./clock";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Model, Tab, max_panes } from "./layout";
import type { Axis, PaneId } from "./layout";
import { Store, Workspace } from "./workspace";
import { Provider, Each, Text, validRef } from "./providers";
import { Agent } from "./agents";
import { Entry, capacity as command_capacity } from "./launch/command";
import { Terminal } from "./pane/terminal";
import { Attachment, Registry } from "./conversations";
import { Tracker } from "./detection";
import { ResumeHint } from "./resume_hint";
import { waitpid, tcgetpgrp, systemCall } from "./native_bridge";
import { attachCommand } from "./claude_daemon";
import * as keys from "./keys";
import * as trackers from "./trackers";
import { Model as AgentModel } from "./providers/model";
import { Status as InferenceStatus } from "./inference/setup";
import { label as paneLabel } from "./pane/label";
import { capacity as order_capacity } from "./agent_order";
import type { Target } from "./agent_order";
export type Create = {
  workspace: number;
  split?: { pane: number; axis: Axis; before?: boolean } | null;
  cwd: string;
  command?: string | null;
  interactive_command?: boolean;
  title?: string;
  cols: number;
  rows: number;
  theme: any;
  socket: string;
  executable: string;
};
export const closed_per_workspace = 8;
export class WantedName {
  static wait_ms = 20000;
  constructor(
    public pane: number,
    public name: string,
    public deadline: number,
  ) {}
}
export class TypedRename {
  static wait_ms = 2000;
  constructor(
    public pane: number,
    public name: string,
    public deadline: number,
  ) {}
}
/** A screen's non-blank rows: how many, and the last one. */
function rowsFilled(text: string) {
  let count = 0,
    last = -1;
  text.split("\n").forEach((row, i) => {
    if (!row.trim()) return;
    count++;
    last = i;
  });
  return { count, last };
}
/** Whether an agent has drawn about as much as its old screen held: most of
 * its rows, reaching about as far down. A resumed agent redraws its
 * conversation, not the same screen, and its startup screen is far emptier. */
export function filledLike(screen: string, old: string) {
  const now = rowsFilled(screen),
    before = rowsFilled(old);
  return now.count >= before.count * 0.75 && now.last >= before.last - 3;
}
export class Ghost {
  static quiet_ms = 300;
  static longest_ms = 2000;
  /** How long an agent may draw without looking loaded before it shows anyway. */
  static give_up_ms = 10000;
  old_screen = true;
  drawn_at: number | null = null;
  changed_at = 0;
  /** Whether the agent's screen holds about what the old screen did. */
  filled = false;
  /** The pane's title before its agent ran, for a provider that titles its
   * terminal only once its conversation has loaded. */
  untitled: string | null = null;
  /** Since when the agent has looked loaded. */
  loaded_at: number | null = null;
  fork: string | null = null;
  constructor(
    public terminal: Terminal,
    public revision: bigint | number,
    public text: string | null,
  ) {}
  due() {
    if (this.drawn_at === null) return null;
    if (this.loaded_at === null) return this.drawn_at + Ghost.give_up_ms;
    return Math.min(this.changed_at + Ghost.quiet_ms, this.loaded_at + Ghost.longest_ms);
  }
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export class Launch {
  constructor(
    public agent?: { provider: Provider; yolo?: boolean },
    public command?: string,
  ) {}
  static from(value: any) {
    return value instanceof Launch ? value : new Launch(value.agent, value.command);
  }
  toJSON() {
    return this.agent ? { agent: this.agent } : { command: this.command };
  }
  typed(resuming: string[] | null = null) {
    let out = this.agent
      ? this.agent.provider + (this.agent.yolo ? " " + Provider.info(this.agent.provider).yolo_flag : "")
      : (this.command ?? "");
    if (resuming) out += " " + resuming[1] + " " + quote(resuming[2]);
    return out;
  }
  forking(provider: Provider, session: string, new_session: string | null = null, name: string | null = null) {
    const info = Provider.info(provider);
    let out = this.typed() + " " + info.fork_args[0] + " " + quote(session);
    if (info.fork_args[1]) out += " " + info.fork_args[1];
    if (info.fork_session_flag && new_session) out += " " + info.fork_session_flag + " " + quote(new_session);
    if (info.name_flag && name) out += " " + info.name_flag + " " + quote(name);
    return out;
  }
  static observed(provider: Provider, pid: number) {
    let yolo = false;
    if (pid > 0)
      try {
        yolo = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(Provider.info(provider).yolo_flag);
      } catch {}
    return new Launch({ provider, yolo });
  }
  paneCommand(executable: string, typed: string) {
    return this.agent ? `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${quote(executable)} agent ${typed}` : typed;
  }
}
export class Pane {
  label = "";
  attachment = new Attachment();
  detection = new Tracker();
  detected = { output: 0n as bigint | number, at: 0 };
  resume_hint = new ResumeHint();
  launch: Launch | null = null;
  background_job: string | null = null;
  ghost: Ghost | null = null;
  /** Recovered with nothing running: its old screen, faded, until `Runtime.wake`. */
  dormant = false;
  static quiet_detection_ms = 2000;
  constructor(
    public id: number,
    public terminal: Terminal,
    public cwd: string,
  ) {}
  agent(): Agent {
    return this.attachment.agent();
  }
  detectionDue(now: number) {
    if (this.terminal.surface_revision !== this.detected.output || now - this.detected.at >= Pane.quiet_detection_ms)
      return true;
    const a = this.agent();
    if (
      this.detection.missing > 0 ||
      (a.last_seq === 0 && this.detection.candidate !== null && this.detection.candidate !== a.state)
    )
      return true;
    return ["working", "blocked", "initializing"].includes(a.state) || a.permission_review !== null;
  }
  displayed() {
    return this.ghost?.terminal ?? this.terminal;
  }
  watchGhost(now: number) {
    const g = this.ghost;
    if (!g) return false;
    if (g.revision !== this.terminal.surface_revision) {
      g.revision = this.terminal.surface_revision;
      const text = this.terminal.liveText();
      if (text !== g.text) {
        g.text = text;
        g.changed_at = now;
        g.drawn_at ??= now;
        const old = g.old_screen ? g.terminal.liveText() : null;
        if (text === old) {
          this.dropGhost();
          return true;
        }
        g.filled = old === null || filledLike(text, old);
      }
    }
    if (g.filled && (g.untitled === null || this.terminal.title !== g.untitled)) g.loaded_at ??= now;
    else g.loaded_at = null;
    const due = g.due();
    if (due === null || now < due) return false;
    this.dropGhost();
    return true;
  }
  dropGhost() {
    this.ghost?.terminal.destroy();
    this.ghost = null;
  }
  /** Typing into a restored agent shows it at once, so what's typed shows. */
  typed(data: string) {
    if (!this.ghost || keys.mouseReport(data)) return false;
    this.dropGhost();
    return true;
  }
  async resize(cols: number, rows: number) {
    await this.terminal.resize(cols, rows);
    if (this.ghost) {
      await this.ghost.terminal.resize(cols, rows);
      if (this.ghost.drawn_at === null) {
        this.ghost.revision = this.terminal.surface_revision;
        this.ghost.text = this.terminal.liveText();
      }
    }
  }
  /** The command a reopened agent runs while its old screen shows, or a
   * dormant one will run. */
  restoring() {
    if (!this.ghost && !this.dormant) return "";
    return (
      this.ghost?.fork ??
      (this.background_job
        ? attachCommand(new Text(this.background_job))
        : (this.resumeLaunch()?.typed(this.resume_hint.args()) ?? ""))
    );
  }
  /** How its agent comes back: as it was launched, or as its provider starts. */
  resumeLaunch() {
    return this.launch ?? (this.resume_hint.provider ? new Launch({ provider: this.resume_hint.provider }) : null);
  }
  /** Shows its saved screen, faded, with nothing running until `Runtime.wake`. */
  async sleep() {
    const t = await Terminal.create(this.terminal.cols, this.terminal.rows);
    t.feed(this.terminal.fadedSnapshot());
    t.exited = true;
    this.terminal.destroy();
    this.terminal = t;
    this.dormant = true;
    this.background_job = this.resumeLaunch()?.agent ? (this.resume_hint.backgroundJob()?.text() ?? null) : null;
  }
  failed() {
    return (
      this.terminal.exited && this.terminal.runs_command && this.launch !== null && this.terminal.exit_status !== 0
    );
  }
  keepFailed() {
    const t = this.terminal;
    if (t.pid < 0) return false;
    t.read();
    this.dropGhost();
    this.attachment.detach();
    t.feed(ending(t.exit_status));
    t.stop();
    return true;
  }
  refreshCwd() {
    if (this.terminal.exited) return;
    const pgid = tcgetpgrp(this.terminal.fd);
    for (const pid of [this.detection.pid, pgid, this.terminal.pid]) {
      if (pid <= 0) continue;
      try {
        const cwd = systemCall({ op: "process.cwd", pid });
        if (typeof cwd === "string") {
          this.cwd = cwd;
          return;
        }
      } catch {}
    }
  }
}
export function ending(status: number) {
  return status & 127
    ? `\x1b[0m\r\n\x1b[2m# Ended by signal ${status & 127}\x1b[0m\r\n`
    : `\x1b[0m\r\n\x1b[2m# Exited with code ${(status >>> 8) & 255}\x1b[0m\r\n`;
}
export class ClosedAgent {
  label = "";
  launch: Launch | null = null;
  pane = 0;
  tab_index: number | null = null;
  constructor(
    public terminal: Terminal,
    public cwd: string,
    public tab: Tab,
    public workspace_id: number,
    public resume_hint: ResumeHint,
  ) {}
  destroy() {
    this.terminal.destroy();
  }
}
function clone(m: Model) {
  const next = Model.fromData(m.toJSON());
  next.next_id = m.next_id;
  return next;
}
export class Runtime {
  workspaces = new Store();
  panes: Pane[] = [];
  closed: ClosedAgent[] = [];
  stopped: number[] = [];
  sessions: any[] = [];
  renames: TypedRename[] = [];
  wanted_names: WantedName[] = [];
  next_session = 1;
  last_agent: Provider = "codex";
  agent_yolo = new Each(false);
  agent_hidden = new Each(false);
  agent_commands = Array.from({ length: command_capacity }, () => new Entry());
  conversations = new Registry();
  system_model = new AgentModel();
  staged_version = "";
  inference = new InferenceStatus();
  system_working = false;
  system_usage = { known: true };
  revision = 1n;
  durable = 1n;
  shown = 1n;
  git_push = new trackers.git_push.Manager();
  git_status = new trackers.git_status.Tracker();
  worktree_tracker = new trackers.worktrees.Tracker();
  ports = new trackers.ports.Tracker();
  resources = new trackers.resources.Tracker();
  link_labels = new trackers.link_labels.Cache();
  changed() {
    this.revision = BigInt.asUintN(64, this.revision + 1n);
    this.durable = BigInt.asUintN(64, this.durable + 1n);
    this.shown = BigInt.asUintN(64, this.shown + 1n);
  }
  refreshed() {
    this.revision = BigInt.asUintN(64, this.revision + 1n);
    this.shown = BigInt.asUintN(64, this.shown + 1n);
  }
  wrote() {
    this.revision = BigInt.asUintN(64, this.revision + 1n);
    this.durable = BigInt.asUintN(64, this.durable + 1n);
  }
  adopt() {
    for (const p of [...this.panes, ...this.closed]) p.terminal.owner = "runtime";
    for (const s of this.sessions) s.owner = "runtime";
  }
  [Symbol.dispose]() {
    this.destroy();
  }
  destroy() {
    this.resources.close();
    this.ports.close();
    this.git_push.close();
    this.git_status.close();
    this.worktree_tracker.close();
    for (const p of this.panes) {
      p.dropGhost();
      p.terminal.destroy();
    }
    for (const p of this.closed) p.destroy();
    for (const s of this.sessions) s.destroy();
    this.panes = [];
    this.closed = [];
    this.sessions = [];
  }
  pane(id: number) {
    return this.panes.find(p => p.id === id) ?? null;
  }
  attachments(actor: any) {
    return (
      this.panes.filter(p => (p.dormant || !p.terminal.exited) && p.attachment.actor === actor).length +
      this.sessions.filter(s => !s.exited && s.members.includes(actor)).length
    );
  }
  followed(actor: any) {
    for (let i = 0; i < 1024 && actor; i++) {
      if (this.attachments(actor) > 0) return true;
      actor = actor.parent ? this.conversations.byId(actor.parent) : null;
    }
    return false;
  }
  getWorkspace(id: number) {
    const w = this.workspaces.get(id);
    if (!w) throw Error("NoWorkspace");
    return w;
  }
  lastAgent(ws: Workspace) {
    return (ws.last_agent ?? this.last_agent) as Provider;
  }
  rememberAgent(id: number, p: Provider) {
    this.last_agent = p;
    const w = this.workspaces.owner(id);
    if (w) w.last_agent = p;
  }
  async create(opts: Create) {
    if (this.panes.length >= max_panes) throw Error("TooManyPanes");
    const ws = this.getWorkspace(opts.workspace),
      next = clone(ws.model);
    next.next_id = this.workspaces.next_pane_id;
    const id = opts.split ? next.split(opts.split.pane, opts.split.axis) : next.newTab(opts.title ?? "");
    if (opts.split?.before) next.swap(id, opts.split.pane);
    next.revision = BigInt.asUintN(64, next.revision + 1n);
    const dir = await Store.directory(opts.cwd),
      t = await Terminal.create(opts.cols, opts.rows);
    try {
      t.applyTheme(opts.theme);
      await t.spawn(dir, opts.socket, id, opts.executable, opts.command ?? null, opts.interactive_command ?? false);
    } catch (e) {
      t.destroy();
      throw e;
    }
    this.panes.push(new Pane(id, t, dir));
    ws.model = next;
    this.workspaces.next_pane_id = next.next_id;
    this.changed();
    return id;
  }
  close(id: number) {
    const owner = this.workspaces.owner(id);
    if (!owner) throw Error("NoPane");
    const tab = owner.model.tabForPane(id)!,
      previous = owner.model.tabs[tab];
    owner.model.close(id);
    owner.model.revision = BigInt.asUintN(64, owner.model.revision + 1n);
    const tab_index = tab + Number(owner.model.tabIndex(previous.id) !== null),
      i = this.panes.findIndex(p => p.id === id);
    if (i >= 0) {
      const p = this.panes[i];
      p.dropGhost();
      p.refreshCwd();
      p.terminal.read();
      p.terminal.reap();
      p.resume_hint.observe(p.agent());
      const running = (p.dormant || !p.terminal.exited) && p.attachment.actor !== null;
      this.stopShell(p.terminal);
      if (running && p.resume_hint.args() !== null) {
        if (this.closedCount(owner.id) === closed_per_workspace) {
          const n = this.closedIndex(owner.id, "oldest")!;
          this.closed.splice(n, 1)[0].destroy();
        }
        const saved = new ClosedAgent(p.terminal, p.cwd, previous, owner.id, p.resume_hint);
        saved.label = p.label;
        saved.launch = p.launch;
        saved.pane = id;
        saved.tab_index = tab_index;
        this.closed.push(saved);
      } else p.terminal.destroy();
      this.panes.splice(i, 1);
    }
    this.changed();
  }
  closedCount(ws: number) {
    return this.closed.filter(p => p.workspace_id === ws).length;
  }
  closedIndex(ws: number, which: "oldest" | "newest") {
    const indexes = this.closed.map((p, i) => (p.workspace_id === ws ? i : -1)).filter(i => i >= 0);
    return (which === "oldest" ? indexes[0] : indexes.at(-1)) ?? null;
  }
  stopShell(t: Terminal) {
    // Bun owns waitpid for Bun.spawn children. Only native children enter this
    // reaper; stealing a Bun child's status rejects its exited promise.
    if (t.owner === "runtime" && !t.child && !t.imported && !t.exited && t.pid > 0) this.stopped.push(t.pid);
    t.stop();
  }
  reapStopped() {
    this.stopped = this.stopped.filter(pid => waitpid(pid) === 0);
  }
  reopen(opts: Create) {
    const i = this.closedIndex(opts.workspace, "newest");
    if (i === null) throw Error("NoClosedAgent");
    return this.reopenClosed(i, opts);
  }
  closedConversation(provider: Provider, session: string) {
    for (let i = this.closed.length - 1; i >= 0; i--) {
      const h = this.closed[i].resume_hint;
      if (h.provider === provider && h.session.text() === session) return i;
    }
    return null;
  }
  async reopenClosed(index: number, opts: Create) {
    const saved = this.closed[index],
      old = saved.terminal.fadedSnapshot(),
      launch = saved.launch ?? new Launch({ provider: saved.resume_hint.provider! });
    const id = await this.resumeAgent(
      {
        ...opts,
        cwd: saved.cwd,
        title: saved.tab.title,
        cols: saved.terminal.vt.cols,
        rows: saved.terminal.vt.rows,
      },
      launch,
      saved.resume_hint,
      old,
    );
    const ws = this.getWorkspace(opts.workspace);
    if (saved.workspace_id === opts.workspace) {
      if (saved.tab_index !== null) {
        ws.model.moveTab(ws.model.tabs[ws.model.count - 1].id, Math.min(saved.tab_index, ws.model.count - 1));
        ws.model.revision = BigInt.asUintN(64, ws.model.revision + 1n);
      }
      ws.agent_order.items = ws.agent_order.items.map(t => ("pane" in t && t.pane === saved.pane ? { pane: id } : t));
    }
    this.pane(id)!.label = saved.label;
    this.closed.splice(index, 1);
    saved.destroy();
    return id;
  }
  async frozenScreen(opts: Pick<Create, "cols" | "rows" | "theme">, old: string | Uint8Array | null) {
    const t = await Terminal.create(opts.cols, opts.rows);
    t.applyTheme(opts.theme);
    if (old) t.feed(old);
    return t;
  }
  /** Shows `frozen` over `p` until its agent looks loaded. `p` keeps the old
   * scrollback but starts with a blank screen, so any draw shows, even one
   * that repaints the old screen. */
  haunt(p: Pane, frozen: Terminal, old: string | Uint8Array | null, fork: string | null) {
    if (old) {
      p.terminal.feed(old);
      p.terminal.feed("\x1b[H\x1b[J");
    }
    p.ghost = new Ghost(frozen, p.terminal.surface_revision, p.terminal.liveText());
    p.ghost.old_screen = old !== null;
    p.ghost.fork = fork;
    const provider = p.resumeLaunch()?.agent?.provider;
    if (provider && Provider.info(provider).screen.titled_once_loaded) p.ghost.untitled = p.terminal.title;
  }
  async resumeAgent(opts: Create, launch: Launch, hint: ResumeHint, old: string | Uint8Array | null) {
    if (!hint.provider || !hint.args()) throw Error("InvalidSession");
    const job = launch.agent ? hint.backgroundJob() : null;
    const typed = job ? attachCommand(job) : launch.typed(hint.args()),
      command = launch.paneCommand(opts.executable, typed),
      frozen = await this.frozenScreen(opts, old);
    let id: number;
    try {
      id = await this.create({
        ...opts,
        command,
        interactive_command: !launch.agent,
      });
    } catch (e) {
      frozen.destroy();
      throw e;
    }
    const p = this.pane(id)!;
    this.resumed(p, opts.workspace, launch, hint, job);
    this.haunt(p, frozen, old, null);
    return id;
  }
  resumed(p: Pane, workspace: number, launch: Launch, hint: ResumeHint, job: Text | null) {
    p.resume_hint = hint;
    p.launch = launch;
    p.background_job = job?.text() ?? null;
    try {
      const actor = this.conversations.get(hint.provider!, hint.session.text());
      actor.state.reopened(Date.now() * 1000);
      if (!actor.state.name.len) actor.state.name = hint.name;
      if (!actor.workspace) actor.workspace = workspace;
      p.attachment.select(actor);
    } catch (error) {
      console.warn("attaching a resumed agent:", error);
    }
  }
  /** Starts a dormant pane's agent in place, its old screen held as a ghost
   * until the agent draws; or a shell with the command typed but not run. */
  async wake(id: number, opts: Pick<Create, "socket" | "executable" | "theme">, shell: boolean) {
    const p = this.pane(id);
    if (!p) throw Error("NoPane");
    if (!p.dormant) throw Error("NotDormant");
    const hint = p.resume_hint,
      launch = p.resumeLaunch(),
      args = hint.args();
    if (!launch || !args) throw Error("InvalidSession");
    const job = launch.agent ? hint.backgroundJob() : null,
      typed = job ? attachCommand(job) : launch.typed(args),
      old = p.terminal.fadedSnapshot(),
      { cols, rows } = p.terminal,
      frozen = shell ? null : await this.frozenScreen({ cols, rows, theme: opts.theme }, old),
      t = await Terminal.create(cols, rows);
    try {
      t.applyTheme(opts.theme);
      if (shell) {
        t.feed(old);
        t.feed(hint.banner(Math.trunc(Date.now() / 1000)));
      }
      const command = shell ? null : launch.paneCommand(opts.executable, typed);
      await t.spawn(await Store.directory(p.cwd), opts.socket, id, opts.executable, command, !launch.agent);
    } catch (e) {
      t.destroy();
      frozen?.destroy();
      throw e;
    }
    p.terminal.destroy();
    p.terminal = t;
    p.dormant = false;
    if (frozen) {
      this.resumed(p, this.workspaces.owner(id)!.id, launch, hint, job);
      this.haunt(p, frozen, old, null);
    } else t.prefill(typed);
    this.changed();
  }
  static forkSource(p: Pane): [Provider, string] {
    const a = p.agent(),
      provider = a.provider,
      session = a.sessionId();
    if (!provider || session.length !== 36 || !validRef({ id: session })) throw Error("NoConversation");
    if (provider === "claude" && a.transcriptPath())
      try {
        lstatSync(a.transcriptPath());
      } catch {
        throw Error("NoConversation");
      }
    return [provider, session];
  }
  async forkAgent(opts: Create, id: number, wanted: string | null) {
    const name = wanted === null ? null : wanted.replace(/^ +| +$/g, "");
    if (name !== null && !validName(name)) throw Error("InvalidName");
    const p = this.pane(id);
    if (!p) throw Error("NoPane");
    const [provider, session] = Runtime.forkSource(p),
      launch = p.launch ?? Launch.observed(provider, p.detection.pid),
      newSession = Provider.info(provider).fork_session_flag ? randomUUID() : null,
      typed = launch.forking(provider, session, newSession, name),
      old = p.terminal.fadedSnapshot(),
      forked = {
        ...opts,
        command: launch.paneCommand(opts.executable, typed),
        interactive_command: !launch.agent,
        cols: p.terminal.vt.cols,
        rows: p.terminal.vt.rows,
      },
      frozen = await this.frozenScreen(forked, old),
      ws = this.workspaces.owner(id)!,
      sourceTab = ws.model.tabs[ws.model.tabForPane(id)!].id;
    let created: number;
    try {
      created = await this.create(forked);
    } catch (e) {
      frozen.destroy();
      throw e;
    }
    const fork = this.pane(created)!;
    fork.launch = launch;
    this.haunt(fork, frozen, old, typed);
    const pickedName = name ?? p.agent().name.text();
    if (newSession) {
      try {
        const actor = this.conversations.get(provider, newSession);
        actor.state.reopened(clock.microTimestamp());
        if (!actor.state.name.len) actor.state.name = new Text(pickedName);
        actor.workspace = ws.id;
        fork.attachment.select(actor);
      } catch (error) {
        console.warn("showing a fork:", error);
      }
    } else {
      fork.attachment.provisional.provider = provider;
      fork.attachment.provisional.name = new Text(pickedName);
    }
    if (!Provider.info(provider).name_flag && name)
      this.wanted_names.push(new WantedName(created, name, clock.milliTimestamp() + WantedName.wait_ms));
    ws.model.moveTab(ws.model.tabs[ws.model.count - 1].id, ws.model.tabIndex(sourceTab)! + 1);
    ws.model.revision = BigInt.asUintN(64, ws.model.revision + 1n);
    if (ws.agent_order.len) {
      try {
        ws.agent_order.moveAfter(this.agentTargets(ws), { pane: created }, { pane: id });
      } catch (error) {
        console.warn("placing a fork's row:", error);
      }
    }
    return created;
  }
  agentTargets(ws: Workspace, out: Target[] = []) {
    out.length = 0;
    for (let i = 0; i < ws.model.count; i++)
      for (const p of this.panes) if (ws.model.tabForPane(p.id) === i) out.push({ pane: p.id });
    for (const s of this.sessions) if (s.workspace_id === ws.id) out.push({ native: s.id });
    if (out.length > order_capacity) throw Error("TooManyAgents");
    return out;
  }
  async renameAgent(id: number, wanted: string | null) {
    const p = this.pane(id);
    if (!p) throw Error("NoPane");
    const name = wanted?.trim() ?? null;
    if (name !== null && !validName(name)) throw Error("InvalidName");
    if (p.terminal.exited || !p.agent().provider) throw Error("NoConversation");
    const rename = await import("./agent_rename");
    await rename.renamePane(p, name, this);
  }
  async advanceRenames(now: number) {
    const rename = await import("./agent_rename");
    await rename.advance(this, now);
  }
  async createWorkspace(name: string, opts: Create) {
    const id = await this.workspaces.add(name, opts.cwd);
    try {
      await this.create({ ...opts, workspace: id });
    } catch (e) {
      this.workspaces.items.pop();
      throw e;
    }
    return id;
  }
  closeWorkspace(id: number, close_contents: boolean) {
    const index = this.workspaces.index(id);
    if (index === null) throw Error("NoWorkspace");
    if (this.workspaces.items.length === 1) throw Error("LastWorkspace");
    const ws = this.workspaces.items[index];
    if (!close_contents && (ws.model.count > 0 || this.sessions.some(s => s.workspace_id === id)))
      throw Error("WorkspaceNotEmpty");
    while (ws.model.count) this.close(ws.model.firstPane(ws.model.tabs[0].root));
    for (const c of this.closed.filter(c => c.workspace_id === id)) c.destroy();
    this.closed = this.closed.filter(c => c.workspace_id !== id);
    for (const s of this.sessions.filter(s => s.workspace_id === id)) s.destroy();
    this.sessions = this.sessions.filter(s => s.workspace_id !== id);
    this.workspaces.items.splice(index, 1);
    this.changed();
  }
}
export function validName(s: string) {
  return !!s && Buffer.byteLength(s) <= 80 && !/[\x00-\x1f\x7f]/.test(s);
}
