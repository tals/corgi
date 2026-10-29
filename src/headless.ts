//! Daemon-hosted sessions: a provider client without a terminal, and the
//! conversations, approvals, tools and journal Corgi keeps for it. The client
//! speaks the provider's protocol; this file sees only its events.
import { realpathSync } from "node:fs";
import { Agent, Text, type Provider } from "./agents";
import { Actor, Attachment, Registry } from "./conversations";
import { adapter } from "./providers";
import type { Ask, Client, Event, Input, Saved } from "./providers/adapter";
import { State as Observation } from "./observation";
import { ResumeHint } from "./resume_hint";
import { Counts, Tracker, add } from "./usage/tokens";
import { Tokens } from "./usage/live";
import * as discovery from "./discovery";
import * as json from "./json";
import * as worktrees from "./worktrees";
import { Invalid, captureBinding, restoreBinding, hydrate, type Repairs } from "./persist/checkpoint";
import type { Server } from "./server";
import type { Client as Peer } from "./peer";
import type { DecodedRequest } from "./protocol";
type Request = Extract<
  DecodedRequest,
  { op: "headless.start" | "headless.list" | "headless.stop" | "headless.send" | "headless.events" }
>;

export type Entry = { seq: bigint; event: Event };
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
function validInput(value: any): Input {
  const bad = () => {
    throw Error("InvalidMessage");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) bad();
  const session = value.session === undefined ? undefined : typeof value.session === "string" ? value.session : bad();
  switch (value.kind) {
    case "prompt":
      if (typeof value.text !== "string" || !value.text) bad();
      return { kind: "prompt", text: value.text, ...(session ? { session } : {}) };
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
  static async start(id: number, provider: Provider, cwd: string) {
    const headless = adapter(provider).headless;
    if (!headless) throw Error("HeadlessUnsupported");
    const directory = realpathSync(cwd),
      executable = await discovery.resolve(provider, directory);
    return new Session(id, provider, directory, headless.start({ cwd: directory, account: "", executable }));
  }
  destroy() {
    this.releaseRequests();
    this.client.close();
    this.active_tools = [];
    this.events = [];
  }
  markExited() {
    this.releaseRequests();
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
    if (!id || [id, thread, turn].some(value => Buffer.byteLength(value) > 256)) return;
    if (this.active_tools.some(tool => tool.id === id && tool.thread === thread)) return;
    if (this.active_tools.length >= 128) throw Error("TooManyHeadlessTools");
    this.active_tools.push({ id, thread, turn });
    this.usage_pending.tools = add(this.usage_pending.tools, 1n);
    target.state = "working";
    target.attention = target.observation.unread() ? "finished" : "none";
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
    for (const event of this.client.take()) ding = this.apply(registry, event) || ding;
    return ding;
  }
  private journal(event: Event) {
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
        else this.startTool(target, e.id, thread, e.turn);
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

export async function request(server: Server, client: Peer, request: Request) {
  const runtime = server.runtime;
  if (request.op === "headless.start") {
    const query = request.payload;
    if (!query.prompt.trim()) throw Error("InvalidMessage");
    if (runtime.sessions.length >= 16) throw Error("TooManyHeadlessSessions");
    const workspace = query.workspace ? runtime.getWorkspace(query.workspace) : server.onlyWorkspace();
    const session = await Session.start(runtime.next_session, query.provider, query.cwd || workspace.cwd);
    if (client.dead) {
      session.destroy();
      return;
    }
    session.workspace_id = workspace.id;
    try {
      session.send({ kind: "prompt", text: query.prompt });
    } catch (error) {
      session.destroy();
      throw error;
    }
    runtime.sessions.push(session);
    runtime.next_session = Session.Id.next(runtime.next_session);
    runtime.changed();
    server.dirty = true;
    client.headless_start = { id: session.id, deadline: Date.now() + 60_000 };
    return;
  }
  if (request.op === "headless.list") {
    client.queue({
      ok: true,
      sessions: runtime.sessions.map((session: Session) => ({
        pid: session.client.processes?.()[0] ?? -1,
        session: session.session || null,
        provider: session.provider,
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
    client.queue({ ok: true });
  } else if (request.op === "headless.send") {
    const input = validInput(request.payload.input);
    if (input.kind !== "answer") {
      if (input.session && input.session !== session.session) throw Error("InvalidSession");
      input.session = session.session;
    }
    session.send(input);
    client.queue({ ok: true });
  } else if (request.op === "headless.events") {
    client.queue({
      ok: true,
      events: session.events.filter(entry => entry.seq > BigInt(request.payload.after)),
      pending_requests: session.pendingRequests(),
      next_seq: session.next_seq,
      first_seq: session.events[0]?.seq ?? session.next_seq,
    });
    session.acknowledge();
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
    if (error) {
      if (session && !session.session) {
        session.destroy();
        server.runtime.sessions.splice(server.runtime.sessions.indexOf(session), 1);
      }
      client.queue({ err: error });
    } else client.queue({ ok: true, provider: session!.provider, session: session!.session });
    client.done();
    server.runtime.changed();
    server.dirty = true;
  }
}
