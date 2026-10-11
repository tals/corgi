import { realpathSync } from "node:fs";
import { Agent, Text, type Provider } from "./agents";
import { Actor, Attachment, Registry } from "./conversations";
import { Backend, Provider as Providers } from "./providers";
import { Codex, ItemType } from "./providers/codex";
import { field, str } from "./providers/common";
import { State as Observation } from "./observation";
import { ResumeHint } from "./resume_hint";
import { View, Tokens } from "./usage/live";
import { Counts, Tracker, add } from "./usage/tokens";
import { n, ptr } from "./native_bridge";
import { native as fdNative } from "./fd_loop";
import * as discovery from "./discovery";
import * as json from "./json";
import * as binary from "./base64";
import * as worktrees from "./worktrees";
import { captureBinding, restoreBinding, hydrate } from "./persist/checkpoint";

export type Event = { seq: bigint; line: string };
export type Tool = { id: string; thread: string; turn: string };
export class RequestId {
  constructor(readonly value: bigint | string) {}
  static init(value: unknown): RequestId | null {
    if (typeof value === "string") return new RequestId(Buffer.from(value).subarray(0, 96).toString());
    if (typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value)))
      return new RequestId(BigInt(value));
    return null;
  }
  eql(other: RequestId | null) {
    return other !== null && this.value === other.value;
  }
}
export class PendingRequest {
  constructor(
    public line: string,
    public actor: Actor | null,
    public id: RequestId | null,
    public tool: boolean,
  ) {}
  static init(provider: Provider, line: string, actor: Actor | null) {
    const event = Backend.init(provider).nativeEvent(json.parse(line));
    return new PendingRequest(line, actor, RequestId.init(event.request_id), event.tool_request);
  }
}
export type Options = {
  args?: string[];
  executable?: string;
  inference?: boolean;
};
function pipe() {
  const fds = new Int32Array(2);
  if (n.probe_pipe(ptr(fds)) !== 0) throw Error("PipeFailed");
  return [...fds];
}
export class Session {
  static Id = { none: 0, first: 1, next: (id: number) => id + 1 };
  child: {
    id: number | null;
    stdin: { handle: number } | null;
    stdout: { handle: number } | null;
  } = { id: null, stdin: null, stdout: null };
  owner: "runtime" | "handoff" = "runtime";
  ready = false;
  imported = false;
  resume_hint = new ResumeHint();
  workspace_id = 0;
  exited = false;
  attachment = new Attachment();
  members: Actor[] = [];
  requests_released = false;
  invalid_json_logged = false;
  input: Buffer = Buffer.alloc(0);
  output: Buffer = Buffer.alloc(0);
  deferred: Buffer = Buffer.alloc(0);
  events: Event[] = [];
  approvals: PendingRequest[] = [];
  active_threads = new Map<string, string>();
  active_tools: Tool[] = [];
  usage_pending = new Counts();
  usage_tracker = new Tracker();
  journal_bytes = 0;
  next_seq = 1n;
  private paused = false;
  private childExited = false;
  constructor(
    public id: number,
    public provider: Provider,
    public cwd: string,
  ) {
    this.attachment.provisional.provider = provider;
    this.attachment.provisional.state = "initializing";
    this.resume_hint.provider = provider;
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
    if (this.members.length >= 256) throw Error("TooManyNativeConversations");
    this.members.push(owner);
  }
  approvalLines() {
    return this.approvals.map(request => request.line);
  }
  hasApproval(actor: Actor | null) {
    return actor ? actor.pending_native_requests > 0 : this.approvals.some(request => request.actor === null);
  }
  releaseRequests() {
    if (this.requests_released) return;
    this.requests_released = true;
    for (const request of this.approvals) {
      if (!request.actor) continue;
      const owner = request.actor;
      owner.pending_native_requests = Math.max(0, owner.pending_native_requests - 1);
      if (owner.pending_native_requests) continue;
      if (owner.state.attention === "needs_input")
        owner.state.attention = owner.state.observation.unread() ? "finished" : "none";
    }
  }
  syncTools(target: Agent) {
    target.tool_active =
      this.active_tools.some(tool => tool.thread === target.sessionId()) ||
      this.approvals.some(request => request.tool && (request.actor?.state ?? this.attachment.provisional) === target);
  }
  static start(id: number, provider: Provider, cwd: string) {
    return this.startWithOptions(id, provider, cwd, {});
  }
  static async startWithOptions(id: number, provider: Provider, cwd: string, options: Options) {
    const directory = realpathSync(cwd);
    const executable = options.executable ?? (await discovery.resolve(provider, directory));
    const session = new Session(id, provider, directory);
    const [childInput, parentInput] = pipe();
    const [parentOutput, childOutput] = pipe();
    const env = { ...process.env };
    delete env.CORGI_PANE;
    if (options.inference) {
      for (const name of [
        "CORGI_SOCKET",
        "CORGI_NATIVE_SESSION",
        "CMUX_SURFACE_ID",
        "CMUX_WORKSPACE_ID",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
      ])
        delete env[name];
      env.CMUX_CODEX_HOOKS_DISABLED = "1";
    }
    try {
      const child = Bun.spawn([executable, ...(options.args ?? Providers.info(provider).native_args)], {
        cwd: directory,
        env,
        stdin: childInput,
        stdout: childOutput,
        stderr: options.inference ? "ignore" : "inherit",
        detached: true,
      });
      session.child = {
        id: child.pid,
        stdin: { handle: parentInput },
        stdout: { handle: parentOutput },
      };
      void child.exited.then(() => {
        session.childExited = true;
      });
    } catch (error) {
      n.probe_close(parentInput);
      n.probe_close(parentOutput);
      throw error;
    } finally {
      n.probe_close(childInput);
      n.probe_close(childOutput);
    }
    n.probe_nonblock(parentInput);
    n.probe_nonblock(parentOutput);
    fdNative.fd_cloexec(parentInput);
    fdNative.fd_cloexec(parentOutput);
    session.ready = provider === "claude";
    session.agent().state = session.ready ? "idle" : "initializing";
    if (!session.ready)
      session.queue({
        id: "__corgi_init",
        method: "initialize",
        params: { clientInfo: { name: "corgi", version: "0.1.0" } },
      });
    return session;
  }
  destroy() {
    this.releaseRequests();
    if (this.owner === "runtime" && !this.exited && this.child.id) {
      try {
        process.kill(-this.child.id, "SIGKILL");
      } catch {
        try {
          process.kill(this.child.id, "SIGKILL");
        } catch {}
      }
    }
    for (const fd of [this.child.stdin?.handle, this.child.stdout?.handle]) if (fd !== undefined) n.probe_close(fd);
    this.child.stdin = this.child.stdout = null;
    this.active_tools = [];
    this.events = [];
  }
  markExited() {
    this.releaseRequests();
    this.exited = true;
    this.attachment.provisional.state = "done";
    this.active_tools = [];
  }
  reap() {
    if (this.exited || this.imported || !this.childExited) return false;
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
    this.owner = "runtime";
    this.imported = true;
    this.resume();
  }
  toolActive() {
    return !this.exited && (this.active_tools.length > 0 || this.approvals.some(request => request.tool));
  }
  startTool(target: Agent, id: string, thread: string, turn: string) {
    if (!id || [id, thread, turn].some(value => Buffer.byteLength(value) > 256)) return;
    if (this.active_tools.some(tool => tool.id === id && tool.thread === thread)) return;
    if (this.active_tools.length >= 128) throw Error("TooManyNativeTools");
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
  observeTools(target: Agent, value: any, params: any, method: string, kind: string) {
    if (this.provider === "codex") {
      const thread = str(params, "threadId");
      if (method === "thread/tokenUsage/updated")
        this.usage_pending.add(
          this.usage_tracker.codexNotification(thread, field(params, "tokenUsage"), this.active_threads.has(thread)),
        );
      if (method === "item/completed") this.finishTool(str(field(params, "item"), "id"), thread);
      else if (method === "item/started" && ItemType.includes(str(field(params, "item"), "type") as any))
        this.startTool(target, str(field(params, "item"), "id"), thread, str(params, "turnId"));
      else if (method === "turn/completed") this.clearTools(thread, str(field(params, "turn"), "id") || null);
    } else {
      if (kind === "result") {
        this.clearTools(target.sessionId(), null);
        return;
      }
      if (kind !== "assistant" && kind !== "user") return;
      const message = field(value, "message");
      if (kind === "assistant") {
        const delta = this.usage_tracker.claudeMessage(message);
        delta.tools = 0n;
        this.usage_pending.add(delta);
      }
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block.type === "tool_use") this.startTool(target, str(block, "id"), target.sessionId(), "");
        if (block.type === "tool_result") this.finishTool(str(block, "tool_use_id"), target.sessionId());
      }
    }
  }
  codexThread(registry: Registry, owner: Actor, value: any) {
    if (!owner.native_usage) {
      owner.native_usage = true;
      owner.native_meter.meter.value = new View({
        ...owner.live_usage,
        tokens: new Tokens(owner.live_usage.tokens),
      });
      owner.native_meter.meter.value.recent_tokens = 0n;
      owner.native_meter.baseline_next = owner.live_usage.known || this.active_threads.has(owner.state.sessionId());
      if (owner.native_meter.baseline_next) owner.native_meter.meter.value.partial = true;
    }
    const thread = field(field(value, "params"), "thread") ?? field(field(value, "result"), "thread");
    const parent = registry.find("codex", str(thread, "parentThreadId"));
    if (parent) registry.linkChild(parent, owner);
    const role = str(thread, "agentRole");
    if (role) owner.role = Text.ascii(role);
  }
  queue(value: any) {
    const line = Buffer.from(json.stringify(value) + "\n");
    if (this.output.length + line.length - 1 > 1024 * 1024) throw Error("NativeBackpressure");
    this.output = Buffer.concat([this.output, line]);
  }
  send(_registry: Registry, value: any) {
    if (this.exited) throw Error("NativeExited");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("InvalidMessage");
    if (str(value, "id") === "__corgi_init") throw Error("ReservedRequestId");
    if (this.ready) this.queue(value);
    else {
      const line = Buffer.from(json.stringify(value) + "\n");
      if (this.deferred.length + line.length - 1 > 1024 * 1024) throw Error("NativeBackpressure");
      this.deferred = Buffer.concat([this.deferred, line]);
    }
    const id = RequestId.init(Backend.init(this.provider).responseId(value));
    if (!id) return;
    const resolved = this.approvals.filter(request => id.eql(request.id));
    this.approvals = this.approvals.filter(request => !id.eql(request.id));
    for (const request of resolved) {
      const owner = request.actor;
      const target = owner?.state ?? this.attachment.provisional;
      if (owner) owner.pending_native_requests = Math.max(0, owner.pending_native_requests - 1);
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

  flush() {
    if (this.exited || this.paused || !this.child.stdin) return;
    while (this.output.length) {
      const size = n.probe_write(this.child.stdin.handle, ptr(this.output), this.output.length);
      if (size <= 0) break;
      this.output = Buffer.from(this.output.subarray(size));
    }
  }
  poll(registry: Registry) {
    if (this.exited || this.paused || !this.child.stdout) return false;
    this.flush();
    let ding = false;
    const buffer = Buffer.alloc(16384);
    for (let i = 0; i < 8; i++) {
      const size = n.probe_read(this.child.stdout.handle, ptr(buffer), buffer.length);
      if (size <= 0) {
        if (size === 0 && this.imported) this.markExited();
        break;
      }
      this.input = Buffer.concat([this.input, buffer.subarray(0, size)]);
      if (this.input.length > 4 * 1024 * 1024) throw Error("NativeMessageTooLarge");
      let end: number;
      while ((end = this.input.indexOf(10)) >= 0) {
        ding = this.ingest(registry, this.input.subarray(0, end).toString()) || ding;
        this.input = Buffer.from(this.input.subarray(end + 1));
      }
    }
    return ding;
  }
  ingest(registry: Registry, line: string) {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw Error("NativeMessageTooLarge");
    let value: any;
    try {
      value = json.parse(line);
    } catch {
      this.invalid_json_logged = true;
      return false;
    }
    const method = this.provider === "codex" ? str(value, "method") : "";
    const kind = this.provider === "claude" ? str(value, "type") : "";
    const event = Backend.init(this.provider).nativeEvent(value);
    if (event.initialize) {
      if (event.initialization_failed) throw Error("NativeInitializeFailed");
      this.queue({ method: "initialized" });
      this.output = Buffer.concat([this.output, this.deferred]);
      this.deferred = Buffer.alloc(0);
      this.ready = true;
      this.attachment.provisional.state = "idle";
    }
    const actor = event.session ? registry.get(this.provider, event.session) : this.attachment.actor;
    if (actor) {
      if (this.provider === "codex") this.codexThread(registry, actor, value);
      this.remember(actor);
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
            actor.pending_native_requests++;
          }
        for (const tool of this.active_tools) if (!tool.thread) tool.thread = actor.state.sessionId();
      }
      const selects =
        method === "thread/started" ||
        (this.provider === "codex" && field(value, "result") !== null && !!event.session);
      if (!this.attachment.actor || (selects && actor.parent === null)) this.attachment.select(actor);
      if (this.attachment.actor === actor) this.resume_hint.observe(actor.state);
      if (method === "item/completed")
        worktrees.recordWrites(actor.state, Codex.writes([field(field(value, "params"), "item")], this.cwd));
    }
    const target = actor?.state ?? this.attachment.provisional;
    target.provider = this.provider;
    if (target.state === "unknown" && this.ready) target.state = "idle";
    const old = target.state;
    let ding = false;
    const params = field(value, "params");
    const reported = event.turn || str(params, "turnId");
    const completed = !!reported && target.finishedTurn(reported);
    const stale =
      completed || (event.phase !== "working" && !!reported && !!target.turn.len && reported !== target.turnId());
    if (!stale || event.phase === "completed") this.observeTools(target, value, params, method, kind);
    if (actor && method === "thread/tokenUsage/updated")
      actor.native_meter.native(field(params, "tokenUsage"), this.active_threads.has(event.session), Date.now());
    if (event.request_id !== null) {
      const id = RequestId.init(event.request_id);
      if (!this.approvals.some(request => request.actor === actor && id !== null && id.eql(request.id))) {
        if (this.approvals.length >= 64) throw Error("TooManyNativeRequests");
        this.approvals.push(new PendingRequest(line, actor, id, event.tool_request));
        if (actor) actor.pending_native_requests++;
      }
      target.beginTurn("");
      target.state = "blocked";
      target.attention = "needs_input";
    } else if (event.phase === "working" && !completed) {
      if (event.thread) this.active_threads.set(event.thread, event.turn);
      target.beginTurn(event.turn);
    } else if (event.phase === "completed") {
      const active = this.active_threads.get(event.thread);
      const matches =
        this.provider === "codex"
          ? !stale &&
            ((active !== undefined && (!active || active === event.turn)) ||
              target.state === "working" ||
              target.state === "blocked")
          : !target.finished_since_activity && (old === "working" || old === "blocked");
      if (active !== undefined && (!event.turn || !active || active === event.turn))
        this.active_threads.delete(event.thread);
      if (matches) ding = target.endTurn(event.turn, event.outcome, "protocol", Date.now() * 1000);
    }
    if (!stale && this.hasApproval(actor)) {
      target.state = "blocked";
      target.attention = "needs_input";
    }
    if (
      !stale &&
      (event.phase !== "none" ||
        event.request_id !== null ||
        method === "item/started" ||
        method === "item/completed" ||
        kind === "user")
    )
      this.syncTools(target);
    if (!stale && (target.state !== old || event.phase !== "none" || event.request_id !== null)) {
      target.last_seq = Date.now() * 1000;
      target.changed_at = target.last_seq;
      target.observation.source = "protocol";
    }
    if (target.state !== old && target.attention === "needs_input") ding = true;
    while (
      this.events.length &&
      (this.events.length >= 128 || this.journal_bytes + Buffer.byteLength(line) > 4 * 1024 * 1024)
    )
      this.journal_bytes -= Buffer.byteLength(this.events.shift()!.line);
    this.events.push({ seq: this.next_seq++, line });
    this.journal_bytes += Buffer.byteLength(line);
    return ding;
  }
  capture(live: boolean) {
    return {
      binding: captureBinding(this.attachment, live),
      members: this.members.map(actor => actor.id),
      approval_actors: this.approvals.map(request => request.actor?.id ?? 0),
      usage_tracker: this.usage_tracker,
      observation: this.observation(),
      turns: [...this.active_threads].map(([thread, turn]) => ({
        thread,
        turn,
      })),
      id: this.id,
      provider: this.provider,
      cwd: this.cwd,
      workspace_id: this.workspace_id,
      pid: live ? (this.child.id ?? -1) : -1,
      stdin: live ? (this.child.stdin?.handle ?? -1) : -1,
      stdout: live ? (this.child.stdout?.handle ?? -1) : -1,
      ready: this.ready,
      exited: this.exited,
      state: this.status(),
      attention: this.attention(),
      input: binary.encode(live ? this.input : Buffer.alloc(0)),
      output: binary.encode(live ? this.output : Buffer.alloc(0)),
      deferred: binary.encode(live ? this.deferred : Buffer.alloc(0)),
      events: this.events,
      approvals: this.approvalLines(),
      tools: this.active_tools,
      next_seq: this.next_seq,
      journal_bytes: this.journal_bytes,
      resume_hint: this.resume_hint,
    };
  }
  static restore(saved: any, registry: Registry, live: boolean) {
    const session = new Session(saved.id, saved.provider, saved.cwd);
    session.attachment = restoreBinding(registry, saved.binding, live);
    session.ready = saved.ready;
    session.exited = live ? saved.exited : true;
    session.imported = live;
    session.workspace_id = saved.workspace_id;
    session.resume_hint = hydrate(new ResumeHint(), saved.resume_hint);
    session.usage_tracker = live ? Tracker.restore(saved.usage_tracker) : new Tracker();
    if (
      (saved.members?.length ?? 0) > 256 ||
      ((saved.approval_actors?.length ?? 0) > 0 && saved.approval_actors.length !== saved.approvals.length)
    )
      throw Error("InvalidCheckpoint");
    for (const id of saved.members ?? []) {
      const actor = registry.byId(id);
      if (!actor || actor.state.provider !== saved.provider || session.members.includes(actor))
        throw Error("InvalidCheckpoint");
      session.members.push(actor);
    }
    if (!session.members.length && session.attachment.actor) session.members.push(session.attachment.actor);
    session.requests_released = session.exited;
    session.child.id = saved.pid;
    if (live) session.owner = "handoff";
    if (live && saved.stdin >= 0) session.child.stdin = { handle: saved.stdin };
    if (live && saved.stdout >= 0) session.child.stdout = { handle: saved.stdout };
    for (const file of [session.child.stdin, session.child.stdout]) if (file) fdNative.fd_cloexec(file.handle);
    session.input = binary.decode(saved.input);
    session.output = binary.decode(saved.output);
    session.deferred = binary.decode(saved.deferred);
    session.events = saved.events.map((event: any) => ({
      seq: BigInt(event.seq),
      line: event.line,
    }));
    session.next_seq = BigInt(saved.next_seq);
    session.journal_bytes = saved.journal_bytes;
    if (live) {
      for (const [i, line] of (saved.approvals ?? []).entries()) {
        const id = saved.approval_actors?.length ? saved.approval_actors[i] : (session.attachment.actor?.id ?? 0);
        const actor = id ? registry.byId(id) : null;
        if (id && !actor) throw Error("InvalidCheckpoint");
        session.approvals.push(PendingRequest.init(saved.provider, line, actor));
        if (!session.exited && actor) actor.pending_native_requests++;
      }
      session.active_threads = new Map((saved.turns ?? []).map((turn: any) => [turn.thread, turn.turn]));
      session.active_tools = (saved.tools ?? []).map((tool: Tool) => ({
        ...tool,
      }));
    }
    return session;
  }
}

export async function request(server: any, client: any, op: string, query: any) {
  const runtime = server.runtime;
  if (op === "native.start") {
    if (runtime.sessions.length >= 16) throw Error("TooManyNativeSessions");
    const workspace = query.workspace ? runtime.getWorkspace(query.workspace) : server.onlyWorkspace();
    const session = await Session.start(runtime.next_session, query.provider, query.cwd || workspace.cwd);
    session.workspace_id = workspace.id;
    runtime.sessions.push(session);
    runtime.next_session = Session.Id.next(runtime.next_session);
    server.dirty = true;
    client.queue({ ok: true, session: session.id, provider: query.provider });
    return;
  }
  if (op === "native.list") {
    client.queue({
      ok: true,
      sessions: runtime.sessions.map((session: Session) => ({
        id: session.id,
        pid: session.child.id ?? -1,
        session_id: session.resume_hint.session.text(),
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
  const index = runtime.sessions.findIndex((session: Session) => session.id === query.session);
  if (index < 0) throw Error("NoNativeSession");
  const session: Session = runtime.sessions[index];
  server.dirty = true;
  if (op === "native.stop") {
    session.destroy();
    runtime.sessions.splice(index, 1);
    client.queue({ ok: true });
  } else if (op === "native.send") {
    session.send(runtime.conversations, query.message);
    client.queue({ ok: true });
  } else if (op === "native.events") {
    client.queue({
      ok: true,
      events: session.events.filter(event => event.seq > BigInt(query.after ?? 0)),
      pending_requests: session.approvalLines(),
      next_seq: session.next_seq,
      first_seq: session.events[0]?.seq ?? session.next_seq,
    });
    session.acknowledge();
  }
}
