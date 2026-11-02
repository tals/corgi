import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Event, Inference, Input, Place } from "../adapter";
import { API, data, eventSession, items, modelRef, object, tokens, validSession } from "./api";
import { field, str } from "../common";
import * as json from "../../json";
import { Accounts } from "./identity";
export const outcome = (value: unknown) =>
  value === "interrupted" ? "interrupted" : value === "failed" ? "failed" : "completed";
export function messageText(value: unknown) {
  const parts = field(value, "content");
  return Array.isArray(parts)
    ? parts
        .filter(p => str(p, "type") === "text")
        .map(p => str(p, "text"))
        .join("\n")
    : str(value, "text");
}
export class Engine {
  session = "";
  closed = false;
  polling = false;
  turns = new Map<string, string>();
  seen = new Map<string, string>();
  requests = new Map<string, { session: string; form: boolean }>();
  answer = "";
  /** An event touched the conversation since the last poll. */
  due = true;
  /** While the event stream is down, it polls as often as an event could come. */
  live = false;
  polled = 0;
  /** When a failed poll is tried again. */
  retry = Infinity;
  private accounts: Accounts;
  private identities = new Map<string, string>();
  constructor(
    readonly api: API,
    readonly emit: (event: Event) => void,
    readonly inference: Inference | null = null,
  ) {
    this.accounts = new Accounts(api);
  }
  async start() {
    const info = data(
      await this.api.call("POST", "/api/session", {
        location: { directory: this.api.cwd },
        ...(this.inference
          ? {
              title: "Corgi inference",
              permissions: [{ action: "*", resource: "*", effect: "deny" }],
              ...(this.inference.model ? { model: modelRef(this.inference.model) } : {}),
            }
          : {}),
      }),
    );
    this.session = str(info, "id");
    if (!validSession(this.session)) throw Error("BadOpenCodeResponse");
    this.emit({ kind: "conversation", session: this.session, parent: null, role: null, shown: true });
    this.emit({ kind: "ready" });
  }
  async send(input: Input) {
    if (this.inference) {
      if (input.kind !== "prompt") throw Error("UnsupportedInput");
      const schema = this.inference.schema ? "\nReturn only JSON matching this schema:\n" + this.inference.schema : "";
      input = { ...input, text: this.inference.instructions + schema + "\n\n" + input.text };
    }
    if (input.kind === "answer") {
      const request = this.requests.get(input.request);
      if (!request) throw Error("UnknownRequest");
      const base = `/api/session/${request.session}/${request.form ? "form" : "permission"}/${encodeURIComponent(input.request)}`;
      if (request.form) {
        if (input.allow)
          await this.api.call("POST", base + "/reply", { answer: object(JSON.parse(input.message ?? "{}")) });
        else await this.api.call("DELETE", base);
      } else
        await this.api.call("POST", base + "/reply", {
          decision: input.allow ? "once" : "reject",
          ...(input.message ? { message: input.message } : {}),
        });
      this.requests.delete(input.request);
      return;
    }
    const session = input.session || this.session;
    if (!validSession(session) || (session !== this.session && !this.turns.has(session))) throw Error("InvalidSession");
    if (input.kind === "interrupt") {
      await this.api.call("POST", `/api/session/${session}/interrupt?resume=false`);
      return;
    }
    await this.api.call("POST", `/api/session/${session}/prompt`, { text: input.text, delivery: "steer" });
  }
  /** Decode a projected context in order. Repeated polls and streaming
   * updates count each completed message and tool only once. */
  decode(session: string, messages: Record<string, unknown>[]) {
    let turn = "";
    for (const msg of messages) {
      const id = str(msg, "id"),
        type = str(msg, "type"),
        key = session + ":" + id;
      if (type === "user") {
        turn = id;
        if (!this.seen.has(key)) {
          this.answer = "";
          this.turns.set(session, turn);
          this.emit({ kind: "turn", session, turn, phase: "started" });
          this.seen.set(key, "done");
        }
      } else if (type === "idle") {
        if (!this.seen.has(key)) {
          if (this.inference && msg.outcome === "succeeded") {
            if (this.inference.schema) JSON.parse(this.answer);
            this.emit({ kind: "message", session, text: this.answer });
          }
          this.emit({
            kind: "turn",
            session,
            turn: this.turns.get(session) || turn,
            phase: "ended",
            outcome: outcome(msg.outcome),
          });
          this.seen.set(key, "done");
        }
      } else if (type === "assistant") {
        const content = field(msg, "content");
        for (const raw of Array.isArray(content) ? content : []) {
          const part = object(raw);
          if (part.type !== "tool") continue;
          const tool = str(part, "id"),
            toolKey = key + ":" + tool,
            done = typeof field(field(part, "time"), "completed") === "number";
          if (!this.seen.has(toolKey)) this.emit({ kind: "tool", session, turn, id: tool, done: false, wrote: [] });
          if (done && this.seen.get(toolKey) !== "done")
            this.emit({ kind: "tool", session, turn, id: tool, done: true, wrote: [] });
          this.seen.set(toolKey, done ? "done" : "running");
        }
        if (typeof field(field(msg, "time"), "completed") !== "number" || this.seen.has(key)) continue;
        const text = messageText(msg);
        if (text) {
          if (this.inference) this.answer = text;
          else this.emit({ kind: "message", session, text });
        }
        const files = field(field(msg, "snapshot"), "files");
        if (Array.isArray(files) && files.length)
          this.emit({
            kind: "tool",
            session,
            turn,
            id,
            done: true,
            wrote: files.filter((p): p is string => typeof p === "string").map(p => resolve(this.api.cwd, p)),
          });
        this.seen.set(key, "done");
      }
    }
  }
  /** Marks the conversation due when an event names it or one of its subagents. */
  observe(event: Record<string, unknown>) {
    if (this.accounts.invalidate(str(event, "type"))) this.due = true;
    const session = eventSession(event);
    if (!session || str(event, "type").endsWith(".delta")) return;
    if (session === this.session || this.turns.has(session) || str(field(event, "data"), "parentID") === this.session)
      this.due = true;
  }
  /** Whether to poll now: after an event or a failure, and otherwise as a sweep. */
  wanted(now: number) {
    return this.due || now >= this.retry || now - this.polled >= (this.live ? 10000 : 300);
  }
  async poll() {
    if (this.closed || this.polling || !this.session) return;
    this.polling = true;
    this.due = false;
    this.retry = Infinity;
    this.polled = Date.now();
    try {
      const children = await this.api.sessions("&parentID=" + encodeURIComponent(this.session), () => this.closed);
      for (const session of [this.session, ...children.entries.map(e => str(e, "id"))].slice(0, 32)) {
        if (this.closed) return;
        if (session !== this.session && !this.turns.has(session)) {
          this.turns.set(session, "");
          this.emit({ kind: "conversation", session, parent: this.session, role: "subagent", shown: false });
        }
        const context = items(await this.api.call("GET", `/api/session/${session}/context`));
        const info = data(await this.api.call("GET", `/api/session/${session}`));
        const account = await this.accounts.describe(info),
          encoded = JSON.stringify(account);
        if (this.identities.get(session) !== encoded) {
          this.identities.set(session, encoded);
          this.emit({ kind: "account", session, account });
        }
        const last = context.findLast(m => m.type === "assistant" && m.tokens);
        this.emit({
          kind: "usage",
          session,
          turn: str(
            context.findLast(m => m.type === "user"),
            "id",
          ),
          total: { total: tokens(info.tokens), last: last ? tokens(last.tokens) : null },
        });
        this.decode(session, context);
        for (const form of [false, true]) {
          const pending = items(await this.api.call("GET", `/api/session/${session}/${form ? "form" : "permission"}`));
          const ids = new Set(pending.map(req => str(req, "id")));
          for (const [id, request] of this.requests)
            if (request.session === session && request.form === form && !ids.has(id)) {
              this.requests.delete(id);
              this.emit({
                kind: "request_closed",
                session,
                id,
                running: context.findLast(m => m.type === "user" || m.type === "idle")?.type === "user",
              });
            }
          for (const req of pending) {
            const id = str(req, "id");
            if (!id || this.requests.has(id)) continue;
            this.requests.set(id, { session, form });
            this.emit({
              kind: "request",
              session,
              id,
              ask: {
                tool: !form,
                name: str(req, form ? "title" : "action"),
                summary: JSON.stringify(form ? req.fields : req.resources),
              },
            });
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
export async function run() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let engine: Engine | null = null,
    timer: ReturnType<typeof setInterval> | null = null;
  const abort = new AbortController();
  const emit = (event: Event) => process.stdout.write(json.stringify({ event }) + "\n");
  const failure = () => {
    if (engine) engine.retry = Date.now() + 1000;
    process.stdout.write(JSON.stringify({ error: "OpenCodeRequestFailed" }) + "\n");
  };
  try {
    for await (const line of lines) {
      if (line.length > 1024 * 1024) throw Error("MessageTooLarge");
      const input = JSON.parse(line);
      if (!engine) {
        const at = input.at as Place,
          started = new Engine(new API(at.executable, at.cwd), emit, input.inference);
        engine = started;
        await started.start();
        void started.api.follow(abort.signal, {
          connected: () => {
            started.live = true;
            started.due = true;
          },
          event: event => started.observe(event),
          lost: () => (started.live = false),
        });
        timer = setInterval(() => {
          if (started.wanted(Date.now())) void started.poll().catch(failure);
        }, 50);
      } else await engine.send(input as Input);
    }
  } catch {
    failure();
  } finally {
    if (engine) engine.closed = true;
    if (timer) clearInterval(timer);
    abort.abort();
    lines.close();
  }
}
