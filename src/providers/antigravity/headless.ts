import { join, isAbsolute } from "node:path";
import type { Client, Event, Inference, Input, Place, Saved } from "../adapter";
import { field, str, number, imageData } from "../common";
import { Tokens } from "../../usage/live";
import { Stdio } from "../stdio";
import * as privateHome from "./private";
import { validSession } from "./config";

type Approval = { id: number | string; allow: string; deny: string };
type Prompt = Extract<Input, { kind: "prompt" }>;
type Startup = { cwd: string; instructions: string; model: string; effort: string };

/** One ACP stdio server, with one session and one outstanding prompt request. */
export class Antigravity implements Client {
  ready = false;
  session = "";
  serial = 0;
  turn = "";
  text = "";
  private tokens = new Tokens();
  private events: Event[] = [];
  private pending: Prompt[] = [];
  private approvals = new Map<string, Approval>();
  constructor(
    readonly io: Stdio,
    private startup: Startup,
    private root = "",
  ) {}

  static start(at: Place, inference?: Inference) {
    const root = inference || at.persist === false ? privateHome.create(at.account, !!inference) : "",
      cwd = inference ? join(root, "workspace") : at.cwd,
      env: NodeJS.ProcessEnv = {
        ...process.env,
        ...at.env,
        ...(root || at.account ? { HOME: root || at.account } : {}),
      };
    delete env.CORGI_PANE;
    // System credential stores may scope the cached login by XDG_CONFIG_HOME.
    if (root && !env.XDG_CONFIG_HOME && process.env.HOME)
      env.XDG_CONFIG_HOME = join(at.account || process.env.HOME, ".config");
    const args = [
      at.executable,
      "acp",
      ...(at.unattended && !inference ? ["--dangerously-skip-permissions"] : []),
      ...(inference ? ["--agent", "corgi-summary"] : []),
    ];
    try {
      const self = new Antigravity(
        Stdio.spawn(args, { cwd, env }),
        {
          cwd,
          instructions: inference
            ? [
                inference.instructions,
                inference.schema ? "Return only JSON matching this schema:\n" + inference.schema : "",
              ]
                .filter(Boolean)
                .join("\n\n")
            : at.instructions || "",
          model: inference?.model || at.model || "",
          effort: at.effort || "",
        },
        root,
      );
      self.call("init", "initialize", { protocolVersion: 1, clientCapabilities: {} });
      return self;
    } catch (e) {
      if (root) privateHome.remove(root);
      throw e;
    }
  }
  private call(id: string, method: string, params: unknown) {
    this.io.write({ jsonrpc: "2.0", id, method, params });
  }
  private next() {
    if (!this.ready || this.turn || !this.pending.length) return;
    const input = this.pending[0],
      turn = "turn-" + ++this.serial;
    const prompt = [
      ...(input.text ? [{ type: "text", text: input.text }] : []),
      ...(input.images ?? []).map(image => ({ type: "image", mimeType: image.mime, data: imageData(image) })),
    ];
    this.call(turn, "session/prompt", { sessionId: this.session, prompt });
    this.pending.shift();
    this.turn = turn;
    this.events.push({ kind: "turn", session: this.session, turn, phase: "started" });
  }
  send(input: Input) {
    if (input.kind !== "answer" && input.session && input.session !== this.session) throw Error("WrongSession");
    switch (input.kind) {
      case "prompt":
        if (this.pending.length >= 16) throw Error("HeadlessBackpressure");
        this.pending.push(input);
        try {
          this.next();
        } catch (e) {
          this.pending.pop();
          throw e;
        }
        break;
      case "interrupt":
        this.pending = [];
        if (this.turn) this.io.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.session } });
        break;
      case "answer": {
        const request = this.approvals.get(input.request);
        if (!request) throw Error("NoRequest");
        const optionId = input.allow ? request.allow : request.deny;
        this.io.write({
          jsonrpc: "2.0",
          id: request.id,
          result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } },
        });
        this.approvals.delete(input.request);
        break;
      }
    }
  }
  private started() {
    this.ready = true;
    this.events.push(
      { kind: "conversation", session: this.session, parent: null, role: null, shown: true },
      { kind: "ready" },
    );
    this.startup = { cwd: "", instructions: "", model: "", effort: "" };
    this.next();
  }
  private selectEffort() {
    if (!this.startup.effort) return this.started();
    this.call("effort", "session/set_config_option", {
      sessionId: this.session,
      configId: "thought_level",
      value: this.startup.effort,
    });
  }
  private flushMessage() {
    if (this.text) this.events.push({ kind: "message", session: this.session, text: this.text });
    this.text = "";
  }
  private decode(v: unknown) {
    const id = field(v, "id"),
      method = str(v, "method"),
      p = field(v, "params"),
      session = this.session,
      turn = this.turn;
    if (method) {
      if (method === "session/update" && str(p, "sessionId") === session && turn) {
        const u = field(p, "update");
        switch (str(u, "sessionUpdate")) {
          case "agent_message_chunk":
            this.text += str(field(u, "content"), "text");
            if (this.text.length > 4 * 1024 * 1024) throw Error("HeadlessMessageTooLarge");
            this.events.push({ kind: "partial", session, text: this.text });
            break;
          case "tool_call":
          case "tool_call_update": {
            const status = str(u, "status"),
              id = str(u, "toolCallId");
            if (!id) break;
            this.flushMessage();
            const locations = field(u, "locations");
            this.events.push({
              kind: "tool",
              session,
              turn,
              id,
              done: status === "completed" || status === "failed",
              name: str(u, "kind") || undefined,
              summary: str(u, "title"),
              wrote:
                status === "completed" && str(u, "kind") === "edit" && Array.isArray(locations)
                  ? locations.map(l => str(l, "path")).filter(p => isAbsolute(p))
                  : [],
            });
            break;
          }
        }
      } else if (
        method === "session/request_permission" &&
        (typeof id === "number" || typeof id === "string") &&
        str(p, "sessionId") === session &&
        turn
      ) {
        const options = field(p, "options"),
          call = field(p, "toolCall");
        const once = (kind: string) =>
          Array.isArray(options)
            ? str(
                options.find(o => str(o, "kind") === kind),
                "optionId",
              )
            : "";
        const key = String(id);
        this.approvals.set(key, { id, allow: once("allow_once"), deny: once("reject_once") });
        this.events.push({
          kind: "request",
          session,
          id: key,
          ask: { tool: true, name: str(call, "kind") || "tool", summary: str(call, "title") },
        });
      } else if (id !== null)
        this.io.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not supported" } });
      return;
    }
    const result = field(v, "result"),
      error = field(v, "error");
    if (id === turn && turn) {
      this.flushMessage();
      const stop = str(result, "stopReason"),
        usage = field(result, "usage"),
        input = number(usage, "inputTokens"),
        output = number(usage, "outputTokens");
      if (input !== null && output !== null) {
        const cached = number(usage, "cachedReadTokens") ?? 0n,
          last = new Tokens({ input: input + cached, output, cached_input: cached });
        this.tokens.add(last);
        this.events.push({
          kind: "usage",
          session,
          turn,
          total: { total: new Tokens(this.tokens), last },
        });
      }
      for (const id of this.approvals.keys()) this.events.push({ kind: "request_closed", id, session, running: false });
      this.approvals.clear();
      this.events.push({
        kind: "turn",
        session,
        turn,
        phase: "ended",
        outcome: !error && stop === "end_turn" ? "completed" : stop === "cancelled" ? "interrupted" : "failed",
      });
      this.turn = "";
      this.next();
      return;
    }
    if (error) throw Error(str(error, "message") || "AntigravityStartupFailed");
    switch (id) {
      case "init":
        this.call("new", "session/new", {
          cwd: this.startup.cwd,
          mcpServers: [],
          ...(this.startup.instructions
            ? { _meta: { antigravity: { systemPrompt: { append: this.startup.instructions } } } }
            : {}),
        });
        break;
      case "new":
        this.session = str(result, "sessionId");
        if (!validSession(this.session)) throw Error("InvalidSession");
        if (this.startup.model)
          this.call("model", "session/set_model", { sessionId: this.session, modelId: this.startup.model });
        else this.selectEffort();
        break;
      case "model":
        this.selectEffort();
        break;
      case "effort":
        this.started();
        break;
    }
  }
  take(): Event[] {
    for (const v of this.io.read()) this.decode(v);
    if (this.io.exited) this.events.push({ kind: "ended" });
    return this.events.splice(0);
  }
  wait(deadline: number) {
    return this.io.wait(deadline);
  }
  processes() {
    return this.io.pid > 0 ? [this.io.pid] : [];
  }
  adopt() {
    this.io.adopt();
  }
  close() {
    const owns = this.io.owner === "runtime";
    this.io.close();
    if (owns && this.root) privateHome.remove(this.root);
  }
  save(live: boolean): Saved {
    const io = this.io.save(live);
    return { handles: io.handles, state: this.snapshot(io.state) };
  }
  static restore(saved: Saved, live: boolean) {
    const s = saved.state as ReturnType<Antigravity["snapshot"]>;
    const self = new Antigravity(Stdio.restore({ handles: saved.handles, state: s.io }, live), s.startup, s.root);
    self.ready = s.ready;
    self.session = s.session;
    self.serial = s.serial;
    self.tokens = new Tokens({
      input: number(s.tokens, "input") ?? 0n,
      cached_input: number(s.tokens, "cached_input") ?? 0n,
      output: number(s.tokens, "output") ?? 0n,
    });
    self.turn = s.turn;
    self.text = s.text;
    self.pending = s.pending;
    self.approvals = new Map(s.approvals);
    self.events = s.events;
    return self;
  }
  private snapshot(io: unknown) {
    return {
      io,
      session: this.session,
      ready: this.ready,
      serial: this.serial,
      tokens: this.tokens,
      turn: this.turn,
      text: this.text,
      pending: this.pending,
      approvals: [...this.approvals],
      events: this.events,
      startup: this.startup,
      root: this.root,
    };
  }
}
