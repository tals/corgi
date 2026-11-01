//! Daemon-hosted sessions: a provider client without a terminal, and the
//! conversations, approvals, tools and journal Corgi keeps for it. The client
//! speaks the provider's protocol; this file sees only its events.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { Agent, Text, type Provider } from "./agents";
import { Actor, Attachment, Registry } from "./conversations";
import { adapter } from "./providers";
import {
  image_types,
  type Ask,
  type Client,
  type Event,
  type Image,
  type Input,
  type Place,
  type Saved,
} from "./providers/adapter";
import * as effort from "./providers/effort";
import type { Effort } from "./providers/effort";
import { State as Observation } from "./observation";
import { ResumeHint } from "./resume_hint";
import { Counts, Tracker, add } from "./usage/tokens";
import { Tokens } from "./usage/live";
import * as accounts from "./accounts";
import * as discovery from "./discovery";
import * as json from "./json";
import { truncateUtf8 } from "./bounded_text";
import * as worktrees from "./worktrees";
import { Invalid, captureBinding, restoreBinding, hydrate, type Repairs } from "./persist/checkpoint";
import type { Runtime } from "./runtime";
import type { Server } from "./server";
import { Reply, type Client as Peer } from "./peer";
import type { DecodedRequest } from "./protocol";
type Request = Extract<
  DecodedRequest,
  { op: "headless.start" | "headless.list" | "headless.stop" | "headless.send" | "headless.events" }
>;

export type Entry = { seq: bigint; event: Event };
/** What a session starts with besides its folder; ordinary sessions leave it all out. */
export type Options = Partial<Omit<Place, "cwd" | "executable">>;
export type Tool = { id: string; thread: string; turn: string };
export class PendingRequest {
  constructor(
    public id: string,
    public actor: Actor | null,
    public ask: Ask,
  ) {}
}
/** A client whose process is gone: what a cold checkpoint restores. */
class Gone implements Client {
  constructor(readonly ready: boolean) {}
  send(): void {
    throw Error("HeadlessExited");
  }
  take() {
    return [];
  }
  async wait() {}
  close() {}
  save(): Saved {
    return { state: { ready: this.ready }, handles: [] };
  }
}
/** What a usage event adds to Corgi's counts. A running total counts from
 * its first report on, except for the last request of a turn already
 * running; a part counts once however often it repeats. */
export function counted(tracker: Tracker, e: Extract<Event, { kind: "usage" }>, active: boolean) {
  if (e.part) {
    const t = e.part.tokens;
    return tracker.tokensCached(e.part.id, t.input, t.cached_input, t.output, false);
  }
  if (!e.total) return new Counts();
  const known = tracker.hasSample(e.session),
    t = e.total.total,
    delta = tracker.tokensCached(e.session, t.input, t.cached_input, t.output, true);
  if (!known && active && e.total.last) {
    delta.input = e.total.last.input;
    delta.output = e.total.last.output;
  }
  return delta;
}
/** What `headless.start` asks of the provider, checked: an effort Corgi knows,
 * and an account folder Corgi knows or "" for the default. */
export function startOptions(query: Extract<Request, { op: "headless.start" }>["payload"]): Options {
  const level = query.effort ? effort.parse(query.effort) : null;
  if (query.effort && !level) throw Error("InvalidEffort");
  const account = query.account ? accounts.normalize(query.provider, query.account) : "";
  // A provider without accounts of its own runs only on the default one.
  if (account && !adapter(query.provider).accounts.signin) throw Error("HeadlessAccountUnsupported");
  if (account && !accounts.find(query.provider, account)) throw Error("AccountNotFound");
  return {
    account,
    ...(query.model ? { model: query.model } : {}),
    ...(level ? { effort: level } : {}),
    ...(query.instructions ? { instructions: query.instructions } : {}),
    ...(query.persist ? {} : { persist: false }),
  };
}
/** A tool's name or summary as the journal keeps it: one bounded line with
 * no control characters, so no escape sequence, and the session's folder
 * left off the paths in it. */
function brief(text: string, cwd: string) {
  const line = text
    .trimStart()
    .split("\n", 1)[0]
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .trimEnd();
  return truncateUtf8(cwd.length > 1 ? line.replaceAll(cwd + "/", "") : line, 200);
}
/** Images a prompt carries: absolute paths of a type a model reads, a few at most. */
export function validImages(value: unknown): Image[] {
  if (!Array.isArray(value) || value.length > 8) throw Error("InvalidMessage");
  return value.map(v => {
    if (!v || typeof v.path !== "string" || !isAbsolute(v.path) || !image_types.includes(v.mime))
      throw Error("InvalidMessage");
    return { path: v.path, mime: v.mime };
  });
}
function validInput(value: any): Input {
  const bad = () => {
    throw Error("InvalidMessage");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) bad();
  const session = value.session === undefined ? undefined : typeof value.session === "string" ? value.session : bad();
  switch (value.kind) {
    case "prompt": {
      const images = value.images === undefined ? [] : validImages(value.images);
      if (typeof value.text !== "string" || (!value.text && !images.length)) bad();
      return {
        kind: "prompt",
        text: value.text,
        ...(session ? { session } : {}),
        ...(images.length ? { images } : {}),
      };
    }
    case "answer":
      if (typeof value.request !== "string" || typeof value.allow !== "boolean") bad();
      if (value.message !== undefined && typeof value.message !== "string") bad();
      return { kind: "answer", request: value.request, allow: value.allow, message: value.message };
    case "interrupt":
      return { kind: "interrupt", ...(session ? { session } : {}) };
  }
  return bad();
}
export class Session {
  static Id = { none: 0, first: 1, next: (id: number) => id + 1 };
  /** Provider identity of the root conversation; empty until creation completes. */
  session = "";
  resume_hint = new ResumeHint();
  workspace_id = 0;
  exited = false;
  /** The Corgi prompt's own conversation, which the sidebar leaves out. */
  corgi = false;
  /** What it started with, so a viewer can tell which choice it runs. */
  account = "";
  model = "";
  effort: Effort | null = null;
  persist = true;
  /** The pane whose Corgi chat holds it: reading its events from there
   * claims it, and closing that pane stops it. */
  pane: number | null = null;
  /** When it exited, and the journal entry that says so, until a reader
   * fetched it. */
  exited_at = 0;
  ended_seq: bigint | null = null;
  ended_read = false;
  readonly holder = "session";
  #attachment = new Attachment();
  get attachment(): Attachment {
    this.#attachment.owner ??= this;
    return this.#attachment;
  }
  set attachment(a: Attachment) {
    a.owner = this;
    this.#attachment = a;
  }
  members: Actor[] = [];
  requests_released = false;
  events: Entry[] = [];
  approvals: PendingRequest[] = [];
  active_threads = new Map<string, string>();
  active_tools: Tool[] = [];
  usage_pending = new Counts();
  usage_tracker = new Tracker();
  journal_bytes = 0;
  next_seq = 1n;
  private paused = false;
  /** The client said it ended; `reap` notices once. */
  private ended = false;
  /** Whether a turn already ran when this session first heard of each conversation. */
  private joined = new Map<Actor, boolean>();
  constructor(
    public id: number,
    public provider: Provider,
    public cwd: string,
    public client: Client,
  ) {
    this.attachment.provisional.provider = provider;
    this.attachment.provisional.state = client.ready ? "idle" : "initializing";
    this.resume_hint.provider = provider;
  }
  get ready() {
    return this.client.ready;
  }
  agent() {
    return this.attachment.agent();
  }
  status() {
    if (this.exited) return "done";
    if (!this.ready) return "initializing";
    let result = this.attachment.provisional.state;
    for (const owner of this.members) {
      if (owner.state.state === "blocked") return "blocked";
      if (owner.state.state === "working") result = "working";
    }
    return result === "working" || result === "blocked" ? result : (this.attachment.actor?.state.state ?? result);
  }
  attention() {
    let result = this.attachment.provisional.attention;
    for (const owner of this.members) {
      if (owner.state.attention === "needs_input") return "needs_input";
      if (owner.state.attention === "finished") result = "finished";
    }
    return result;
  }
  observation() {
    const result = new Observation(this.attachment.provisional.observation);
    for (const owner of this.members) {
      const value = owner.state.observation;
      result.completed = add(result.completed, value.completed);
      result.read = add(result.read, value.read);
      result.pending_stop ||= value.pending_stop;
      result.source = value.source;
      result.outcome = value.outcome;
    }
    return result;
  }
  acknowledge() {
    this.attachment.provisional.acknowledge();
    for (const owner of this.members) owner.state.acknowledge();
  }
  remember(owner: Actor) {
    if (this.members.includes(owner)) return;
    if (this.members.length >= 256) throw Error("TooManyHeadlessConversations");
    this.members.push(owner);
  }
  pendingRequests() {
    return this.approvals.map(request => ({
      id: request.id,
      session: request.actor?.state.sessionId() ?? "",
      ask: request.ask,
    }));
  }
  hasApproval(actor: Actor | null) {
    return actor ? actor.pending_headless_requests > 0 : this.approvals.some(request => request.actor === null);
  }
  releaseRequests() {
    if (this.requests_released) return;
    this.requests_released = true;
    for (const request of this.approvals) {
      if (!request.actor) continue;
      const owner = request.actor;
      owner.pending_headless_requests = Math.max(0, owner.pending_headless_requests - 1);
      if (owner.pending_headless_requests) continue;
      if (owner.state.attention === "needs_input")
        owner.state.attention = owner.state.observation.unread() ? "finished" : "none";
    }
  }
  syncTools(target: Agent) {
    target.tool_active =
      this.active_tools.some(tool => tool.thread === target.sessionId()) ||
      this.approvals.some(
        request => request.ask.tool && (request.actor?.state ?? this.attachment.provisional) === target,
      );
  }
  static async start(id: number, provider: Provider, cwd: string, options: Options = {}) {
    const headless = adapter(provider).headless;
    if (!headless) throw Error("HeadlessUnsupported");
    const directory = realpathSync(cwd),
      executable = await discovery.resolve(provider, directory);
    const session = new Session(
      id,
      provider,
      directory,
      headless.start({ ...options, cwd: directory, account: options.account ?? "", executable }),
    );
    session.account = options.account ?? "";
    session.model = options.model ?? "";
    session.effort = options.effort ?? null;
    session.persist = options.persist !== false;
    return session;
  }
  destroy() {
    this.releaseRequests();
    this.client.close();
    this.active_tools = [];
    this.events = [];
  }
  markExited(now = Date.now()) {
    this.releaseRequests();
    if (!this.exited) {
      this.journal({ kind: "ended" });
      this.ended_seq = this.next_seq - 1n;
      this.exited_at = now;
    }
    this.exited = true;
    this.attachment.provisional.state = "done";
    this.active_tools = [];
  }
  /** Whether the client just ended. */
  reap() {
    if (this.exited || !this.ended) return false;
    this.markExited();
    return true;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  adopt() {
    this.client.adopt?.();
    this.resume();
  }
  toolActive() {
    return !this.exited && (this.active_tools.length > 0 || this.approvals.some(request => request.ask.tool));
  }
  startTool(target: Agent, id: string, thread: string, turn: string) {
    if (!id || [id, thread, turn].some(value => Buffer.byteLength(value) > 256)) return false;
    if (this.active_tools.some(tool => tool.id === id && tool.thread === thread)) return false;
    if (this.active_tools.length >= 128) throw Error("TooManyHeadlessTools");
    this.active_tools.push({ id, thread, turn });
    this.usage_pending.tools = add(this.usage_pending.tools, 1n);
    target.state = "working";
    target.attention = target.observation.unread() ? "finished" : "none";
    return true;
  }
  finishTool(id: string, thread: string) {
    this.active_tools = this.active_tools.filter(tool => !(tool.id === id && tool.thread === thread));
  }
  clearTools(thread: string | null, turn: string | null) {
    this.active_tools = this.active_tools.filter(
      tool => !((thread === null || thread === tool.thread) && (turn === null || turn === tool.turn)),
    );
  }
  send(value: unknown) {
    if (this.exited) throw Error("HeadlessExited");
    const input = validInput(value);
    this.client.send(input);
    if (input.kind !== "answer") return;
    const resolved = this.approvals.filter(request => request.id === input.request);
    this.approvals = this.approvals.filter(request => request.id !== input.request);
    for (const request of resolved) {
      const owner = request.actor;
      const target = owner?.state ?? this.attachment.provisional;
      if (owner) owner.pending_headless_requests = Math.max(0, owner.pending_headless_requests - 1);
      if (this.hasApproval(owner)) {
        target.state = "blocked";
        target.attention = "needs_input";
      } else {
        target.state = "working";
        target.attention = target.observation.unread() ? "finished" : "none";
      }
      this.syncTools(target);
    }
  }
  poll(registry: Registry) {
    if (this.exited || this.paused) return false;
    let ding = false;
    const events = this.client.take();
    for (const [i, event] of events.entries()) {
      // Only the newest of a run of partials matters.
      const next = events[i + 1];
      if (event.kind === "partial" && next?.kind === "partial" && next.session === event.session) continue;
      ding = this.apply(registry, event) || ding;
    }
    return ding;
  }
  private journal(event: Event) {
    // A partial replaces its conversation's last one when only partials
    // followed it, so streaming, even several conversations', never evicts
    // real events; the message it streamed replaces it for good.
    const streamed = event.kind === "partial" || event.kind === "message" ? event.session : null;
    for (let i = this.events.length - 1; streamed !== null && i >= 0; i--) {
      const old = this.events[i].event;
      if (old.kind !== "partial") break;
      if (old.session !== streamed) continue;
      this.events.splice(i, 1);
      this.journal_bytes -= Buffer.byteLength(json.stringify(old));
      break;
    }
    const size = Buffer.byteLength(json.stringify(event));
    while (this.events.length && (this.events.length >= 128 || this.journal_bytes + size > 4 * 1024 * 1024))
      this.journal_bytes -= Buffer.byteLength(json.stringify(this.events.shift()!.event));
    this.events.push({ seq: this.next_seq++, event });
    this.journal_bytes += size;
  }
  /** Follows one event: which conversation it's about, its turns, tools,
   * requests and usage. True when it should ring. */
  apply(registry: Registry, e: Event): boolean {
    if (e.kind === "ready") {
      if (this.attachment.provisional.state === "initializing") this.attachment.provisional.state = "idle";
      return false;
    }
    if (e.kind === "ended") {
      this.ended = true;
      return false;
    }
    if (e.kind === "partial") {
      this.journal(e);
      return false;
    }
    if (e.kind === "tool" && (e.name !== undefined || e.summary !== undefined))
      e = {
        ...e,
        ...(e.name !== undefined ? { name: brief(e.name, this.cwd) } : {}),
        ...(e.summary !== undefined ? { summary: brief(e.summary, this.cwd) } : {}),
      };
    const actor = e.session ? registry.get(this.provider, e.session) : this.attachment.actor;
    if (actor) {
      if (e.kind === "conversation") {
        if (!this.session && !e.parent) this.session = e.session;
        const parent = e.parent ? registry.find(this.provider, e.parent) : null;
        if (parent) registry.linkChild(parent, actor);
        if (e.role) actor.role = Text.ascii(e.role);
      }
      this.remember(actor);
      if (!this.joined.has(actor)) this.joined.set(actor, this.active_threads.has(e.session));
      actor.observed_at = Date.now() * 1000;
      if (!actor.workspace) actor.workspace = this.workspace_id;
      if (!this.attachment.actor) {
        if (actor.state.state === "unknown") {
          const session = actor.state.session;
          actor.state = this.attachment.provisional;
          actor.state.provider = this.provider;
          actor.state.session = session;
        }
        this.attachment.provisional = new Agent();
        this.attachment.provisional.provider = this.provider;
        this.attachment.provisional.state = this.ready ? "idle" : "initializing";
        for (const pending of this.approvals)
          if (!pending.actor) {
            pending.actor = actor;
            actor.pending_headless_requests++;
          }
        for (const tool of this.active_tools) if (!tool.thread) tool.thread = actor.state.sessionId();
      }
      if (!this.attachment.actor || (e.kind === "conversation" && e.shown && actor.parent === null))
        this.attachment.select(actor);
      if (this.attachment.actor === actor) this.resume_hint.observe(actor.state);
      if (e.kind === "tool" && e.wrote.length) worktrees.recordWrites(actor.state, e.wrote);
    }
    const target = actor?.state ?? this.attachment.provisional;
    target.provider = this.provider;
    if (target.state === "unknown" && this.ready) target.state = "idle";
    const old = target.state,
      thread = e.session || target.sessionId(),
      reported = "turn" in e ? e.turn : "",
      phase = e.kind === "turn" ? (e.phase === "started" ? "working" : "completed") : "none";
    let ding = false;
    const completed = !!reported && target.finishedTurn(reported);
    const stale = completed || (phase !== "working" && !!reported && !!target.turn.len && reported !== target.turnId());
    if (e.kind === "activity") {
      if (!stale && reported && reported === target.turnId() && ["working", "blocked"].includes(target.state)) {
        target.setActivity(e.text);
        target.activity_inferred = false;
        target.activity_at = Date.now() * 1000;
        actor?.checkpointActivity(e.amend, target.activity_at);
      }
      this.journal(e);
      return false;
    }
    if (!stale || phase === "completed") {
      if (e.kind === "tool") {
        if (e.done) this.finishTool(e.id, thread);
        else if (this.startTool(target, e.id, thread, e.turn) && actor?.headless_usage)
          actor.headless_meter.meter.count(1n);
      } else if (e.kind === "usage") {
        const delta = counted(this.usage_tracker, e, this.active_threads.has(e.session));
        delta.tools = 0n;
        this.usage_pending.add(delta);
      } else if (e.kind === "turn" && e.phase === "ended") this.clearTools(thread, e.turn || null);
    }
    if (e.kind === "usage" && e.total && actor) {
      const active = this.active_threads.has(e.session);
      actor.beginHeadlessUsage(this.joined.get(actor) ?? false);
      actor.headless_meter.sample(new Tokens(e.total.total), e.total.last, active, Date.now());
    }
    if (e.kind === "request_closed") {
      const removed = this.approvals.filter(r => r.id === e.id && r.actor === actor);
      this.approvals = this.approvals.filter(r => !removed.includes(r));
      if (actor) actor.pending_headless_requests = Math.max(0, actor.pending_headless_requests - removed.length);
      if (removed.length && !this.hasApproval(actor)) {
        target.state = e.running ? "working" : "idle";
        target.attention = target.observation.unread() ? "finished" : "none";
      }
      this.syncTools(target);
      if (target.state !== old) target.changed_at = Date.now() * 1000;
      this.journal(e);
      return false;
    }
    if (e.kind === "request") {
      if (!this.approvals.some(request => request.actor === actor && request.id === e.id)) {
        if (this.approvals.length >= 64) throw Error("TooManyHeadlessRequests");
        this.approvals.push(new PendingRequest(e.id, actor, e.ask));
        if (actor) actor.pending_headless_requests++;
      }
      target.beginTurn("");
      target.state = "blocked";
      target.attention = "needs_input";
    } else if (phase === "working" && !completed) {
      if (reported) this.active_threads.set(e.session, reported);
      target.beginTurn(reported);
    } else if (e.kind === "turn" && e.phase === "ended") {
      const active = this.active_threads.get(e.session);
      // A protocol that names turns ends each thread's own; one that doesn't
      // ends the one conversation it runs.
      const matches = reported
        ? !stale &&
          ((active !== undefined && (!active || active === reported)) ||
            target.state === "working" ||
            target.state === "blocked")
        : !target.finished_since_activity && (old === "working" || old === "blocked");
      if (active !== undefined && (!reported || !active || active === reported)) this.active_threads.delete(e.session);
      if (matches)
        ding = target.endTurn(reported, e.outcome, "protocol", Date.now() * 1000) && (actor?.parent ?? null) === null;
    }
    if (!stale && this.hasApproval(actor)) {
      target.state = "blocked";
      target.attention = "needs_input";
    }
    if (!stale && (phase !== "none" || e.kind === "request" || e.kind === "tool")) this.syncTools(target);
    if (!stale && (target.state !== old || phase !== "none" || e.kind === "request")) {
      target.changed_at = Date.now() * 1000;
      target.last_seq = BigInt(target.changed_at);
      target.observation.source = "protocol";
    }
    if (target.state !== old && target.attention === "needs_input") ding = true;
    this.journal(e);
    return ding;
  }
  capture(live: boolean) {
    return {
      binding: captureBinding(this.attachment, live),
      members: this.members.map(actor => actor.id),
      usage_tracker: this.usage_tracker,
      observation: this.observation(),
      turns: [...this.active_threads].map(([thread, turn]) => ({ thread, turn })),
      id: this.id,
      session: this.session,
      provider: this.provider,
      cwd: this.cwd,
      workspace_id: this.workspace_id,
      corgi: this.corgi,
      account: this.account,
      model: this.model,
      effort: this.effort,
      persist: this.persist,
      pane: this.pane,
      client: this.client.save(live),
      ready: this.ready,
      exited: this.exited,
      state: this.status(),
      attention: this.attention(),
      events: this.events,
      approvals: this.approvals.map(request => ({
        id: request.id,
        actor: request.actor?.id ?? 0,
        ask: request.ask,
      })),
      tools: this.active_tools,
      next_seq: this.next_seq,
      journal_bytes: this.journal_bytes,
      resume_hint: this.resume_hint,
    };
  }
  static restore(saved: any, registry: Registry, live: boolean, how: Repairs = {}) {
    const headless = adapter(saved.provider).headless,
      client: Client =
        live && !saved.exited && headless
          ? headless.restore(saved.client ?? { state: null, handles: [] }, live)
          : new Gone(saved.ready === true);
    const session = new Session(saved.id, saved.provider, saved.cwd, client);
    session.attachment = restoreBinding(registry, saved.binding, live, { ...how, what: `native session ${saved.id}` });
    session.exited = live ? saved.exited : true;
    session.workspace_id = saved.workspace_id;
    session.corgi = saved.corgi === true;
    session.account = typeof saved.account === "string" ? saved.account : "";
    session.model = typeof saved.model === "string" ? saved.model : "";
    session.effort = effort.parse(saved.effort);
    session.persist = saved.persist !== false;
    session.pane = typeof saved.pane === "number" ? saved.pane : null;
    session.resume_hint = hydrate(new ResumeHint(), saved.resume_hint);
    session.session = saved.session ?? session.resume_hint.session.text();
    session.usage_tracker = live ? Tracker.restore(saved.usage_tracker) : new Tracker();
    if ((saved.members?.length ?? 0) > 256 || (saved.approvals?.length ?? 0) > 64)
      throw new Invalid(`native session ${saved.id} has too many members or approvals`);
    for (const id of saved.members ?? []) {
      const actor = registry.byId(id);
      if (!actor) throw new Invalid(`native session ${saved.id}'s member, conversation ${id}, isn't saved`);
      if (actor.state.provider !== saved.provider || session.members.includes(actor))
        throw new Invalid(
          `native session ${saved.id}'s member, conversation ${id}, is listed twice or is another provider's`,
        );
      session.members.push(actor);
    }
    if (!session.members.length && session.attachment.actor) session.members.push(session.attachment.actor);
    session.requests_released = session.exited;
    session.events = (saved.events ?? []).map((entry: any) => ({ seq: BigInt(entry.seq), event: entry.event }));
    session.next_seq = BigInt(saved.next_seq);
    session.journal_bytes = saved.journal_bytes;
    // An end a reader may not have fetched yet gets its grace again.
    if (session.exited) {
      session.ended_seq = session.events.findLast(entry => entry.event.kind === "ended")?.seq ?? null;
      session.exited_at = Date.now();
    }
    if (live) {
      for (const request of saved.approvals ?? []) {
        const actor = request.actor ? registry.byId(request.actor) : null;
        if (request.actor && !actor)
          throw new Invalid(
            `native session ${saved.id}'s approval is for conversation ${request.actor}, which isn't saved`,
          );
        session.approvals.push(new PendingRequest(String(request.id), actor ?? null, request.ask));
        if (!session.exited && actor) actor.pending_headless_requests++;
      }
      session.active_threads = new Map((saved.turns ?? []).map((turn: any) => [turn.thread, turn.turn]));
      session.active_tools = (saved.tools ?? []).map((tool: Tool) => ({ ...tool }));
    }
    return session;
  }
}

/** Removes the prompt's sessions that ended, once a reader fetched their
 * end or a minute after; nothing else shows them. True when it removed one. */
export function sweep(runtime: Runtime, now = Date.now()) {
  const gone = runtime.sessions.filter(s => s.corgi && s.exited && (s.ended_read || now - s.exited_at >= 60_000));
  if (!gone.length) return false;
  for (const s of gone) s.destroy();
  runtime.sessions = runtime.sessions.filter(s => !gone.includes(s));
  runtime.changed();
  return true;
}
/** How a prompt session reaches this Corgi: its socket, and its own corgi
 * first on PATH. No pane, so provider hooks and extensions stay quiet. */
export function corgiEnv(socket: string, executable: string): Record<string, string | undefined> {
  return {
    CORGI_SOCKET: socket,
    CORGI_PANE: undefined,
    PATH: `${dirname(executable)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
}
export async function request(server: Server, client: Peer, request: Request, reply = new Reply(client)) {
  const runtime = server.runtime;
  if (sweep(runtime)) server.dirty = true;
  if (request.op === "headless.start") {
    const query = request.payload,
      images = query.images === null ? [] : validImages(query.images);
    if (!query.prompt.trim() && !images.length) throw Error("InvalidMessage");
    if (runtime.sessions.length >= 16) throw Error("TooManyHeadlessSessions");
    const workspace = query.workspace ? runtime.getWorkspace(query.workspace) : server.onlyWorkspace();
    const session = await Session.start(runtime.next_session, query.provider, query.cwd || workspace.cwd, {
      ...startOptions(query),
      ...(query.corgi ? { env: corgiEnv(server.socket, server.executable) } : {}),
    });
    if (client.dead) {
      session.destroy();
      return;
    }
    session.workspace_id = workspace.id;
    session.corgi = query.corgi;
    try {
      session.send({ kind: "prompt", text: query.prompt, ...(images.length ? { images } : {}) });
    } catch (error) {
      session.destroy();
      throw error;
    }
    runtime.sessions.push(session);
    runtime.unarchiveWorkspace(workspace.id);
    runtime.next_session = Session.Id.next(runtime.next_session);
    runtime.changed();
    server.dirty = true;
    await server.saveWorkspaces();
    client.headless_start = { id: session.id, deadline: Date.now() + 60_000, request_id: reply.id };
    return;
  }
  if (request.op === "headless.list") {
    reply.send({
      ok: true,
      sessions: runtime.sessions.map((session: Session) => ({
        pid: session.client.processes?.()[0] ?? -1,
        session: session.session || null,
        provider: session.provider,
        corgi: session.corgi,
        account: session.account,
        model: session.model,
        effort: session.effort,
        persist: session.persist,
        pane: session.pane,
        ready: session.ready,
        exited: session.exited,
        state: session.status(),
        attention: session.attention(),
        observation: session.observation(),
        unread: session.observation().unread(),
        pending_requests: session.approvals.length,
        active_tools: session.active_tools.length,
        next_seq: session.next_seq,
      })),
    });
    return;
  }
  const query = request.payload;
  if (!query.session) throw Error("InvalidSession");
  const matches = runtime.sessions.filter(
    session => session.provider === query.provider && session.session === query.session,
  );
  if (matches.length > 1) throw Error("AmbiguousHeadlessSession");
  const index = matches.length ? runtime.sessions.indexOf(matches[0]) : -1;
  if (index < 0) throw Error("NoHeadlessSession");
  const session: Session = runtime.sessions[index];
  server.dirty = true;
  if (request.op === "headless.stop") {
    session.destroy();
    runtime.sessions.splice(index, 1);
    runtime.changed();
    reply.send({ ok: true });
  } else if (request.op === "headless.send") {
    const input = validInput(request.payload.input);
    if (input.kind !== "answer") {
      if (input.session && input.session !== session.session) throw Error("InvalidSession");
      input.session = session.session;
    }
    session.send(input);
    reply.send({ ok: true });
  } else if (request.op === "headless.events") {
    const after = BigInt(request.payload.after),
      pane = request.payload.pane;
    // A Corgi chat in a pane reads with its pane: the session is that pane's now.
    if (pane !== null && session.pane !== pane) {
      session.pane = pane;
      runtime.changed();
    }
    reply.send({
      ok: true,
      events: session.events.filter(entry => entry.seq > after),
      pending_requests: session.pendingRequests(),
      next_seq: session.next_seq,
      first_seq: session.events[0]?.seq ?? session.next_seq,
    });
    session.acknowledge();
    if (session.ended_seq !== null && session.ended_seq > after) session.ended_read = true;
    sweep(runtime);
  }
}

/** Completes starts on the ordinary tick, without holding the daemon's job queue. */
export function finishStarts(server: Server, now = Date.now()) {
  for (const client of [...server.clients]) {
    const pending = client.headless_start;
    if (!pending) continue;
    const session = server.runtime.sessions.find(s => s.id === pending.id);
    const error = session?.session
      ? null
      : !session || session.exited
        ? "HeadlessExited"
        : now >= pending.deadline
          ? "HeadlessStartTimeout"
          : null;
    if (!error && !session!.session) continue;
    client.headless_start = null;
    const reply = new Reply(client, pending.request_id ?? null);
    if (error) {
      if (session && !session.session) {
        session.destroy();
        server.runtime.sessions.splice(server.runtime.sessions.indexOf(session), 1);
      }
      reply.send({ err: error });
    } else reply.send({ ok: true, provider: session!.provider, session: session!.session });
    client.done();
    server.runtime.changed();
    server.dirty = true;
  }
}
