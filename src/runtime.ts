import * as clock from "./clock";
import * as telemetry from "./telemetry";
import * as os from "./os";
import { Model, Tab } from "./layout";
import type { Axis } from "./layout";
import { Store, Workspace } from "./workspace";
import { Provider, byProvider, Text, validRef, adapter } from "./providers";
import { Agent } from "./agents";
import { Entry, capacity as command_capacity, commandLine, identify } from "./launch/command";
import * as accounts from "./accounts";
import * as agentOptions from "./agent_options";
import { Terminal } from "./pane/terminal";
import { Attachment, Registry, type Actor, type ActorId } from "./conversations";
import { Tracker, locate, process_buffer, type Foreground } from "./detection";
import type { Brand } from "./process_name";
import { ResumeHint } from "./resume_hint";
import { waitpid, tcgetpgrp } from "./native_bridge";
import * as keys from "./keys";
import * as trackers from "./trackers";
import { Model as AgentModel } from "./providers/model";
import { Status as InferenceStatus } from "./inference/setup";
import { index, key as agentKey, section, type Section, type Target } from "./agent_order";
import type { Session } from "./headless";
import { Briefs } from "./worktree_briefs";
import * as worktreeAgents from "./worktree_agents";
import * as breadcrumbs from "./breadcrumbs";
export type Create = {
  workspace: number;
  split?: { pane: number; axis: Axis; before?: boolean } | null;
  cwd: string;
  command?: string | null;
  interactive_command?: boolean;
  /** Variables its command runs with besides Corgi's own. */
  env?: [string, string][];
  title?: string;
  /** Dormant from the start: nothing runs until `Runtime.wake`. */
  asleep?: boolean;
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
    public revision: bigint,
    public text: string | null,
  ) {}
  due() {
    if (this.drawn_at === null) return null;
    if (this.loaded_at === null) return this.drawn_at + Ghost.give_up_ms;
    return Math.min(this.changed_at + Ghost.quiet_ms, this.loaded_at + Ghost.longest_ms);
  }
}
export class Launch {
  constructor(
    public agent?: {
      provider: Provider;
      yolo?: boolean;
      model?: string;
      /** Options and variables kept from a command someone typed to start it. */
      args?: string[];
      env?: [string, string][];
      /** Read off an agent someone started in its pane's shell, which the
       * next one started there replaces. */
      observed?: boolean;
    },
    public command?: string,
  ) {}
  static from(value: any) {
    return value instanceof Launch ? value : new Launch(value.agent, value.command);
  }
  /** Starts `provider` in `account`. */
  static in(provider: Provider, account: string, yolo = false, options = accounts.launchOptions(provider, account)) {
    const flags = agentOptions.args(options.flags),
      args = adapter(provider).launch.options(flags, options.model, options.effort),
      env = [
        ...options.env.filter(([key]) => key !== adapter(provider).accounts.env),
        ...accounts.env(provider, account),
      ];
    return new Launch({
      provider,
      yolo,
      ...(options.model ? { model: options.model } : {}),
      ...(args.length ? { args } : {}),
      ...(env.length ? { env } : {}),
    });
  }
  toJSON() {
    return this.agent ? { agent: this.agent } : { command: this.command };
  }
  private accounts?: Map<Provider, string>;
  /** The account its `provider` agent runs in, as the variables it sets in
   * `cwd` pick it; "" for the default. */
  account(provider: Provider | null = this.agent?.provider ?? null, cwd = "/"): string {
    if (!provider) return "";
    const known = (this.accounts ??= new Map());
    let found = known.get(provider);
    if (found === undefined) {
      const env = this.agent ? (this.agent.env ?? []) : this.command ? commandLine(this.command, cwd).env : [];
      known.set(provider, (found = accounts.of(provider, env, cwd)));
    }
    return found;
  }
  /** The command that starts it, followed by `then`, with the permission
   * checks and model `live` last saw. */
  typed(then: string[] | null = null, live: ResumeHint | null = null) {
    const { agent } = this,
      start = agent
        ? os.shellWords([
            agent.provider,
            ...adapter(agent.provider).launch.start({
              permissions: live?.permissions ?? (agent.yolo ? "bypass" : "default"),
              model: live ? (live.model.len ? live.model.text() : null) : agent.model || null,
              args: agent.args ?? [],
            }),
          ])
        : (this.command ?? "");
    return then?.length ? start + " " + os.shellWords(then) : start;
  }
  /** How the agent at `pid`, which someone started in a pane's shell, starts again. */
  static observed(provider: Provider, pid: number, capture?: (env: [string, string][]) => void) {
    const info = pid > 0 ? os.processArgs(pid, process_buffer, { env: true }) : null,
      found = info?.complete ? locate(info.argv) : null,
      env =
        info && found?.provider === provider
          ? info.environ().flatMap(e => {
              const at = e.indexOf("=");
              return at > 0 ? [[e.slice(0, at), e.slice(at + 1)] as [string, string]] : [];
            })
          : [],
      kept =
        info && found?.provider === provider
          ? adapter(provider).launch.keep?.({
              env,
              args: info.argv.slice(found.at),
              flagged: false,
              cwd: "/",
            })
          : null;
    capture?.(env);
    return new Launch({ provider, args: kept?.args ?? [], env: kept?.env ?? [], observed: true });
  }
  /** How a pane runs it, typed as `typed`. */
  run(executable: string, typed: string): Pick<Create, "command" | "interactive_command" | "env"> {
    return this.agent
      ? {
          command: `${os.shellQuote(executable)} agent ${typed}`,
          interactive_command: false,
          env: this.agent.env ?? [],
        }
      : { command: typed, interactive_command: true, env: [] };
  }
}
export class Pane {
  readonly holder = "pane";
  label = "";
  #attachment = new Attachment();
  get attachment(): Attachment {
    this.#attachment.owner ??= this;
    return this.#attachment;
  }
  set attachment(a: Attachment) {
    a.owner = this;
    this.#attachment = a;
  }
  detection = new Tracker();
  detected = { output: 0n, at: 0 };
  resume_hint = new ResumeHint();
  launch: Launch | null = null;
  /** The command that attaches to its agent where that already runs. */
  attached: string | null = null;
  ghost: Ghost | null = null;
  /** Recovered with nothing running: its old screen, faded, until `Runtime.wake`. */
  dormant = false;
  /** The account the agent a saved command started reads from its own
   * environment, which can say what the command's text can't. */
  running_account: string | null = null;
  agent_env: Record<string, string> = {};
  /** The program in front of its shell, "" at a prompt, and its brand. It
   * shows on a second look, so a quick command doesn't flash. */
  command = "";
  brand: Brand | null = null;
  /** The foreground group and program the last look saw. */
  private seen_front = "";
  private confirming = false;
  static quiet_detection_ms = 2000;
  constructor(
    public id: number,
    public terminal: Terminal,
    public cwd: string,
  ) {}
  agent(): Agent {
    return this.attachment.agent();
  }
  /** Releases detected identity without losing provisional completion receipts. */
  releaseDetection() {
    this.agent_env = {};
    const observation = this.attachment.provisional.observation;
    this.attachment.detach();
    this.attachment.provisional.observation = observation;
    this.attachment.provisional.attention = observation.unread() ? "finished" : "none";
    this.detection = new Tracker();
  }
  /** The provider account its agent runs in, "" for the default. */
  account(): string {
    if (this.detection.claim) return "";
    const launch = this.resumeLaunch(),
      provider =
        this.agent().provider ?? launch?.agent?.provider ?? (launch?.command ? identify(launch.command) : null);
    if (launch?.command && this.running_account !== null && this.detection.pid > 0) return this.running_account;
    return launch?.account(provider, this.cwd) ?? "";
  }
  /** Follows its foreground group; true when `command` changed. */
  observeFront(front: Foreground | null) {
    const command = front?.program?.name ?? "",
      brand = (command && front?.program?.brand) || null,
      seen = front && command ? `${front.pgid} ${command}` : "";
    this.confirming = seen !== "" && seen !== this.seen_front;
    this.seen_front = seen;
    if (this.confirming || (command === this.command && brand === this.brand)) return false;
    this.command = command;
    this.brand = brand;
    return true;
  }
  detectionDue(now: number) {
    if (
      this.terminal.surface_revision !== this.detected.output ||
      now - this.detected.at >= Pane.quiet_detection_ms ||
      this.confirming
    )
      return true;
    const a = this.agent();
    if (
      this.detection.missing > 0 ||
      (a.last_seq === 0n && this.detection.candidate !== null && this.detection.candidate !== a.state)
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
      this.attached ??
      this.resumeLaunch()?.typed(this.resume_hint.args(this.resumeLaunch()?.account()), this.resume_hint) ??
      ""
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
    const launch = this.resumeLaunch();
    this.attached = launch?.agent ? this.resume_hint.attach(launch.account()) : null;
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
  /** A shell waiting at its prompt. Job-control shells (bash, zsh, fish and
   * the rest) give the terminal to each job they run and take it back after,
   * so the shell holds the foreground only while nothing runs in front. */
  idleShell() {
    const t = this.terminal;
    if (t.exited || t.runs_command || t.pid <= 0 || this.ghost) return false;
    return tcgetpgrp(t.fd) === t.pid;
  }
  refreshCwd() {
    const telemetry_started = telemetry.begin();
    try {
      if (this.terminal.exited) return;
      if (this.refreshCwdFrom(this.detection.pid)) return;
      if (this.refreshCwdFrom(tcgetpgrp(this.terminal.fd))) return;
      this.refreshCwdFrom(this.terminal.pid);
    } finally {
      telemetry.end("agent.cwd", telemetry_started);
    }
  }
  private refreshCwdFrom(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      const cwd = os.processCwd(pid);
      if (typeof cwd === "string") {
        this.cwd = cwd;
        return true;
      }
    } catch {}
    return false;
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
  sessions: Session[] = [];
  renames: TypedRename[] = [];
  wanted_names: WantedName[] = [];
  next_session = 1;
  last_agent: Provider = Provider.first;
  agent_yolo = byProvider(() => false);
  agent_hidden = byProvider(() => false);
  /** The accounts whose rows have their own YOLO on, and those the picker hides. */
  account_yolo: string[] = [];
  account_hidden: string[] = [];
  agent_commands = Array.from({ length: command_capacity }, () => new Entry());
  conversations = new Registry();
  /** Live imports keep their bindings here until adoption or rollback. */
  pending_bindings = new Set<Attachment>();
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
  worktree_briefs = new Briefs();
  ports = new trackers.ports.Tracker();
  resources = new trackers.resources.Tracker();
  link_labels = new trackers.link_labels.Cache();
  changed() {
    telemetry.count("runtime.changed");
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
    for (const s of this.sessions) s.adopt();
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
    this.worktree_briefs.close();
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
  /** Panes whose shell waits at its prompt, by workspace then tab; take the
   * first and the rest go unchecked. `workspace` and `cwd` (a real path)
   * narrow them. */
  *idleShells(where: { workspace?: number; cwd?: string } = {}): Generator<Pane> {
    for (const ws of this.workspaces.items) {
      if (where.workspace !== undefined && ws.id !== where.workspace) continue;
      for (const tab of ws.model.tabs.slice(0, ws.model.count))
        for (const p of this.panes) {
          if (!ws.model.contains(tab.root, p.id) || !p.idleShell()) continue;
          if (where.cwd !== undefined) {
            p.refreshCwd();
            if (p.cwd !== where.cwd) continue;
          }
          yield p;
        }
    }
  }
  attachments(actor: any) {
    return (
      this.panes.filter(p => (p.dormant || !p.terminal.exited) && p.attachment.actor === actor).length +
      this.sessions.filter(s => !s.exited && s.members.includes(actor)).length
    );
  }
  /** Current attachments and their descendants, indexed once for a batch. */
  followed(): Set<Actor> {
    const roots = new Set<Actor>(),
      children = new Map<ActorId, Actor[]>();
    for (const pane of this.panes)
      if ((pane.dormant || !pane.terminal.exited) && pane.attachment.actor) roots.add(pane.attachment.actor);
    for (const session of this.sessions) if (!session.exited) for (const actor of session.members) roots.add(actor);
    for (const actor of this.conversations.items) {
      if (actor.parent === null) continue;
      const siblings = children.get(actor.parent);
      if (siblings) siblings.push(actor);
      else children.set(actor.parent, [actor]);
    }
    const followed = new Set(this.conversations.items.filter(actor => roots.has(actor)));
    // Set iteration visits added descendants once, including cyclic families.
    for (const actor of followed) for (const child of children.get(actor.id) ?? []) followed.add(child);
    return followed;
  }
  /** Forgets conversations no pane, pending import, closed agent or
   * headless session refers to. */
  pruneConversations() {
    const keep = new Set<ActorId>(),
      hinted = new Set<string>();
    const bound = (binding: Attachment) => {
      if (binding.actor) keep.add(binding.actor.id);
      for (const id of binding.known) keep.add(id);
    };
    const hint = (h: ResumeHint) => {
      if (h.provider) hinted.add(`${h.provider}:${h.session.text()}`);
    };
    for (const p of this.panes) {
      bound(p.attachment);
      hint(p.resume_hint);
    }
    for (const binding of this.pending_bindings) bound(binding);
    for (const c of this.closed) hint(c.resume_hint);
    for (const s of this.sessions) {
      bound(s.attachment);
      for (const actor of s.members) keep.add(actor.id);
      for (const request of s.approvals) if (request.actor) keep.add(request.actor.id);
    }
    for (const actor of this.conversations.items)
      if (hinted.has(`${actor.state.provider}:${actor.state.sessionId()}`)) keep.add(actor.id);
    return this.conversations.prune(keep);
  }
  getWorkspace(id: number) {
    const w = this.workspaces.get(id);
    if (!w) throw Error("NoWorkspace");
    return w;
  }
  lastAgent(ws: Workspace) {
    return (ws.last_agent ?? this.last_agent) as Provider;
  }
  /** Whether `provider`'s agent in `account` starts with YOLO: the provider's
   * own for the default, else the account's. */
  yolo(provider: Provider, account: string) {
    return account ? this.account_yolo.includes(account) : this.agent_yolo[provider];
  }
  rememberAgent(id: number, p: Provider) {
    this.last_agent = p;
    const w = this.workspaces.owner(id);
    if (w) w.last_agent = p;
  }
  async create(opts: Create) {
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
      if (opts.asleep) t.exited = true;
      else
        await t.spawn(
          dir,
          opts.socket,
          id,
          opts.executable,
          opts.command ?? null,
          opts.interactive_command ?? false,
          opts.env ?? [],
        );
    } catch (e) {
      t.destroy();
      throw e;
    }
    const p = new Pane(id, t, dir);
    p.dormant = opts.asleep === true;
    this.panes.push(p);
    breadcrumbs.record("opened", { owner: p });
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
      if (!p.detection.claim) p.resume_hint.observe(p.agent());
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
      breadcrumbs.record("closed", { owner: p });
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
      const reopened = (t: Target) => ("pane" in t && t.pane === saved.pane ? { pane: id } : t);
      ws.agent_order.items = ws.agent_order.items.map(reopened);
      ws.activity_order.items = ws.activity_order.items.map(reopened);
      ws.pinned_agents.items = ws.pinned_agents.items.map(reopened);
      if (ws.activity_order.has({ pane: id })) ws.restored.add(agentKey({ pane: id }));
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
    if (provider && adapter(provider).caps.titles_once_loaded) p.ghost.untitled = p.terminal.title;
  }
  async resumeAgent(opts: Create, launch: Launch, hint: ResumeHint, old: string | Uint8Array | null) {
    if (!hint.provider || !hint.args(launch.account())) throw Error("InvalidSession");
    const attached = launch.agent ? hint.attach(launch.account()) : null;
    if (opts.asleep) {
      const id = await this.create(opts),
        p = this.pane(id)!;
      if (old) p.terminal.feed(old);
      this.resumed(p, opts.workspace, launch, hint, attached);
      return id;
    }
    const typed = attached ?? launch.typed(hint.args(launch.account()), hint),
      run = launch.run(opts.executable, typed),
      frozen = await this.frozenScreen(opts, old);
    let id: number;
    try {
      id = await this.create({ ...opts, ...run });
    } catch (e) {
      frozen.destroy();
      throw e;
    }
    const p = this.pane(id)!;
    this.resumed(p, opts.workspace, launch, hint, attached);
    this.haunt(p, frozen, old, null);
    return id;
  }
  resumed(p: Pane, workspace: number, launch: Launch, hint: ResumeHint, attached: string | null) {
    p.resume_hint = hint;
    p.launch = launch;
    p.attached = attached;
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
      args = hint.args(launch?.account());
    if (!launch || !args) throw Error("InvalidSession");
    const attached = launch.agent ? hint.attach(launch.account()) : null,
      typed = attached ?? launch.typed(args, hint),
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
      const run = launch.run(opts.executable, typed);
      await t.spawn(
        await Store.directory(p.cwd),
        opts.socket,
        id,
        opts.executable,
        shell ? null : (run.command ?? null),
        run.interactive_command,
        run.env,
      );
    } catch (e) {
      t.destroy();
      frozen?.destroy();
      throw e;
    }
    p.terminal.destroy();
    p.terminal = t;
    p.dormant = false;
    if (frozen) {
      this.resumed(p, this.workspaces.owner(id)!.id, launch, hint, attached);
      this.haunt(p, frozen, old, null);
    } else t.prefill(typed);
    this.changed();
  }
  /** The provider of the conversation `p` shows, and how to fork it. */
  static forkSource(p: Pane, name: string | null = null, cwd = p.cwd) {
    const a = p.agent(),
      provider = a.provider,
      session = a.sessionId(),
      branch =
        provider && validRef({ id: session })
          ? adapter(provider).launch.fork({ session, transcript: a.transcriptPath(), cwd }, name)
          : null;
    if (!provider || !branch) throw Error("NoConversation");
    return { provider, branch };
  }
  async forkAgent(opts: Create, id: number, wanted: string | null) {
    const name = wanted === null ? null : wanted.replace(/^ +| +$/g, "");
    if (name !== null && !validName(name)) throw Error("InvalidName");
    const p = this.pane(id);
    if (!p) throw Error("NoPane");
    const { provider, branch } = Runtime.forkSource(p, name, opts.cwd),
      launch = p.launch ?? Launch.observed(provider, p.detection.pid),
      typed = launch.typed(branch.args, p.resume_hint),
      old = p.terminal.fadedSnapshot(),
      forked = {
        ...opts,
        ...launch.run(opts.executable, typed),
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
    if (branch.session) {
      try {
        const actor = this.conversations.get(provider, branch.session);
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
    if (!branch.named && name)
      this.wanted_names.push(new WantedName(created, name, clock.milliTimestamp() + WantedName.wait_ms));
    ws.model.moveTab(ws.model.tabs[ws.model.count - 1].id, ws.model.tabIndex(sourceTab)! + 1);
    ws.model.revision = BigInt.asUintN(64, ws.model.revision + 1n);
    if (ws.pinned_agents.has({ pane: id })) {
      try {
        ws.pinned_agents.pinAfter(this.agentTargets(ws), { pane: created }, { pane: id });
      } catch (error) {
        console.warn("pinning a fork:", error);
      }
    }
    if (ws.agent_order.len) {
      try {
        ws.agent_order.moveAfter(this.agentTargets(ws), { pane: created }, { pane: id });
      } catch (error) {
        console.warn("placing a fork's row:", error);
      }
    }
    return created;
  }
  /** Changes the star on an agent and remembers its conversation for history. */
  starAgent(ws: Workspace, target: Target, starred: boolean, before: Target | null = null): void {
    const live = this.agentTargets(ws);
    if (index(live, target) === null) {
      if (starred) throw Error("NoAgent");
      ws.pinned_agents.unpin(live, target);
      return;
    }
    if (starred) ws.pinned_agents.pin(live, target, before);
    else ws.pinned_agents.unpin(live, target);
    const agent = this.targetAgent(target);
    const key = agentKey(target);
    let conversation =
      agent?.provider && agent.session.len ? { provider: agent.provider, session: agent.sessionId() } : null;
    // Bound now, so a conversation that just changed doesn't move the star again.
    if (conversation) ws.star_bindings.set(key, conversation);
    else {
      // Between conversations, an unstar still clears the one it was bound to.
      if (!starred) conversation = ws.star_bindings.get(key) ?? null;
      ws.star_bindings.delete(key);
      if (!conversation) return;
    }
    ws.starred_sessions.set(conversation.provider, conversation.session, starred);
    for (const other of live) {
      const state = this.targetAgent(other);
      if (state?.provider !== conversation.provider || state.sessionId() !== conversation.session) continue;
      if (starred && !ws.pinned_agents.has(other)) ws.pinned_agents.pin(live, other, null);
      else if (!starred) ws.pinned_agents.unpin(live, other);
    }
  }
  private targetAgent(target: Target): Agent | null {
    return "pane" in target
      ? (this.pane(target.pane)?.agent() ?? null)
      : (this.sessions.find(s => s.id === target.headless)?.attachment.agent() ?? null);
  }
  /** Remembers old stars and restores them when a conversation opens again. */
  private syncStar(ws: Workspace, live: Target[], target: Target, key: string): boolean {
    const agent = this.targetAgent(target);
    if (!agent?.provider || !agent.session.len) return false;
    const conversation = { provider: agent.provider, session: agent.sessionId() },
      previous = ws.star_bindings.get(key);
    ws.star_bindings.set(key, conversation);
    let changed = false;
    if (
      previous !== undefined &&
      (previous.provider !== conversation.provider || previous.session !== conversation.session) &&
      ws.pinned_agents.has(target)
    ) {
      ws.pinned_agents.unpin(live, target);
      changed = true;
    }
    if (ws.pinned_agents.has(target))
      changed = ws.starred_sessions.set(agent.provider, agent.sessionId(), true) || changed;
    else if (ws.starred_sessions.has(agent.provider, agent.sessionId())) {
      ws.pinned_agents.pin(live, target, null);
      changed = true;
    }
    return changed;
  }
  /** Places new agents in manual order and raises those entering an activity section. */
  raiseEntered(): boolean {
    let changed = false;
    for (const ws of this.workspaces.items) {
      const live = this.agentTargets(ws, []),
        placed = ws.agent_order.slice(),
        seen = new Set<string>();
      for (const target of live) {
        const key = agentKey(target),
          last = ws.sections.get(key),
          // Every move fills the order with all live agents, so being in it
          // doesn't mean an agent had a place there.
          restored = ws.restored.delete(key) && last === undefined,
          kind = this.startingSection(ws, target, key, last, restored);
        seen.add(key);
        changed = this.syncStar(ws, live, target, key) || changed;
        ws.sections.set(key, kind);
        if (kind === null) continue;
        const entered = last === null ? !ws.agent_slots.has(key) : last === undefined && index(placed, target) === null;
        ws.agent_slots.add(key);
        if (entered) {
          const ordered = ws.agent_order
              .without(live, target)
              .items.filter(t => index(placed, t) !== null && this.agentSection(t) !== null),
            checkout = this.agentWorktree(ws, target),
            before = checkout === null ? undefined : ordered.find(t => this.agentWorktree(ws, t) === checkout);
          ws.agent_order.move(live, target, before ?? ordered[0] ?? null);
          placed.push(target);
          changed = true;
        }
        // A restored agent keeps its place until it moves on.
        if (last === kind || restored) continue;
        ws.activity_order.raise(live, target);
        changed = true;
      }
      for (const key of ws.sections.keys()) if (!seen.has(key)) ws.sections.delete(key);
      for (const key of ws.starting) if (!seen.has(key)) ws.starting.delete(key);
      for (const key of ws.star_bindings.keys()) if (!seen.has(key)) ws.star_bindings.delete(key);
      for (const key of ws.agent_slots) if (!seen.has(key)) ws.agent_slots.delete(key);
      for (const key of ws.restored) if (!seen.has(key)) ws.restored.delete(key);
    }
    return changed;
  }
  private agentWorktree(ws: Workspace, target: Target) {
    if ("pane" in target) {
      const p = this.pane(target.pane);
      return p ? worktreeAgents.listedWorktree(ws.worktrees, target, p.agent().cwd.text() || p.cwd) : null;
    }
    const s = this.sessions.find(s => s.id === target.headless);
    return s ? worktreeAgents.listedWorktree(ws.worktrees, target, s.cwd) : null;
  }
  /** An agent's section, except that a new one waits in working until its
   * first turn, through startup and idle. */
  private startingSection(
    ws: Workspace,
    target: Target,
    key: string,
    last: Section | null | undefined,
    restored: boolean,
  ) {
    const kind = this.agentSection(target),
      start = this.agentStart(target),
      fresh = !restored || start?.state === "unknown" || start?.state === "initializing",
      waiting = last ? ws.starting.has(key) : kind !== null && fresh;
    if (waiting && kind === "idle" && start?.completed === 0n) {
      ws.starting.add(key);
      return "working";
    }
    ws.starting.delete(key);
    return kind;
  }
  private agentStart(target: Target) {
    if ("pane" in target) {
      const agent = this.pane(target.pane)?.agent();
      return agent ? { state: agent.state, completed: agent.observation.completed } : null;
    }
    const s = this.sessions.find(s => s.id === target.headless);
    return s ? { state: s.status(), completed: s.observation().completed } : null;
  }
  /** The agents waiting in working for their first turn. */
  startingAgents(ws: Workspace): Target[] {
    return this.agentTargets(ws).filter(t => ws.starting.has(agentKey(t)));
  }
  private agentSection(target: Target) {
    if ("pane" in target) {
      const agent = this.pane(target.pane)?.agent();
      return agent?.provider ? section(agent.state, agent.attention, agent.paused) : null;
    }
    const s = this.sessions.find(s => s.id === target.headless);
    return s ? section(s.status(), s.attention()) : null;
  }
  agentTargets(ws: Workspace, out: Target[] = []) {
    out.length = 0;
    const tabs: Target[][] = Array.from({ length: ws.model.count }, () => []);
    for (const p of this.panes) {
      const tab = ws.model.tabForPane(p.id);
      if (tab !== null) tabs[tab].push({ pane: p.id });
    }
    for (const targets of tabs) out.push(...targets);
    for (const s of this.sessions) if (s.workspace_id === ws.id) out.push({ headless: s.id });
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
    this.workspaces.distinguish(id);
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
