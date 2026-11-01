//! Pi's persistent JSONL RPC transport. A run ends only at agent_settled.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { field, imageData, str, number } from "../common";
import type { Client, Event, Inference, Input, Place, Saved } from "../adapter";
import type { Outcome } from "../../observation";
import { Stdio } from "../stdio";
import * as instructions from "../instructions";
import { Tokens } from "../../usage/live";
export function reported(usage: unknown) {
  const input = number(usage, "input"),
    output = number(usage, "output");
  if (input === null || output === null) return null;
  const cached = number(usage, "cacheRead") ?? 0n;
  return new Tokens({ input: input + cached + (number(usage, "cacheWrite") ?? 0n), cached_input: cached, output });
}
export function messageText(message: unknown) {
  const content = field(message, "content");
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(b => str(b, "type") === "text")
          .map(b => str(b, "text"))
          .join("\n")
      : "";
}
export function outcome(message: unknown): Outcome {
  switch (str(message, "stopReason")) {
    case "aborted":
      return "interrupted";
    case "error":
    case "length":
      return "failed";
    default:
      return "completed";
  }
}
/** What a daemon-hosted session at `at` starts with, besides its mode;
 * `file` holds its instructions, which the flag reads when given a path. */
export function sessionArgs(at: Place, file: string) {
  return [
    ...(at.model ? ["--model", at.model] : []),
    ...(at.effort ? ["--thinking", at.effort] : []),
    ...(file ? ["--append-system-prompt", file] : []),
    ...(at.persist === false ? ["--no-session"] : []),
  ];
}
/** What a tool call is about, in a few words. */
export function about(args: unknown) {
  for (const key of ["command", "path", "file_path", "pattern", "url", "query", "description"])
    if (str(args, key)) return str(args, key);
  return "";
}
/** A built-in tool's name as Claude's are spelled: "read" is "Read". */
export function toolName(name: string) {
  return /^[a-z]+$/.test(name) ? name[0].toUpperCase() + name.slice(1) : name;
}
export function summaryArgs(r: Inference) {
  return [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-tools",
    "--no-approve",
    "--thinking",
    "low",
    "--system-prompt",
    r.instructions + (r.schema ? "\nReturn only JSON conforming to this schema:\n" + r.schema : ""),
    ...(r.model ? ["--model", r.model] : []),
  ];
}
type Dialog = { method: string; options: string[]; expires: number | null };
export class Pi implements Client {
  protected static readonly mode: "rpc" | "rpc-ui" = "rpc";
  ready = false;
  session = "";
  turn = "";
  result: Outcome = "completed";
  interrupted = false;
  next = 0;
  requests = new Map<string, Dialog>();
  writes = new Map<string, string[]>();
  events: Event[] = [];
  failure: Error | null = null;
  ended = false;
  commands: { id: string; type: string; [key: string]: unknown }[] = [];
  awaiting = "";
  /** The text blocks of the assistant message streaming now, by content index. */
  streamed: string[] = [];
  /** The file its instructions are in, which goes with it. */
  file = "";
  constructor(
    readonly io: Stdio,
    readonly cwd: string,
  ) {}
  /** A summary with `args`, or without them a daemon-hosted session. */
  static start(at: Place, args?: string[]) {
    const env = { ...process.env };
    if (at.account) {
      env.PI_CODING_AGENT_DIR = at.account;
    }
    delete env.CORGI_PANE;
    delete env.CORGI_SOCKET;
    Object.assign(env, at.env);
    const file = !args && at.instructions ? instructions.write(at.instructions) : "";
    let io: Stdio;
    try {
      io = Stdio.spawn([at.executable, "--mode", this.mode, ...(args ?? sessionArgs(at, file))], { cwd: at.cwd, env });
    } catch (error) {
      instructions.remove(file);
      throw error;
    }
    const c = new this(io, at.cwd);
    c.file = file;
    c.io.write({ id: "corgi-state", type: "get_state" });
    return c;
  }
  command(command: { id: string; type: string; [key: string]: unknown }) {
    this.commands.push(command);
    this.flushCommand();
  }
  flushCommand() {
    if (this.awaiting || !this.commands.length) return;
    const command = this.commands.shift()!;
    if (command.id.startsWith("corgi-abort-")) this.interrupted = !!this.turn;
    this.io.write(command);
    this.awaiting = command.id;
  }
  abort() {
    // Pi's abort continues queued work unless the queue is cleared first.
    this.command({ id: `corgi-clear-${++this.next}`, type: "clear_queue" });
    this.command({ id: `corgi-abort-${++this.next}`, type: "abort" });
  }
  send(input: Input) {
    if (input.kind !== "answer" && input.session && input.session !== this.session) throw Error("WrongSession");
    switch (input.kind) {
      case "prompt":
        // One sent while it works steers the run, as Enter does in Pi.
        this.command({
          id: `corgi-prompt-${++this.next}`,
          type: "prompt",
          message: input.text,
          ...(input.images?.length
            ? { images: input.images.map(image => ({ type: "image", data: imageData(image), mimeType: image.mime })) }
            : {}),
          streamingBehavior: "steer",
        });
        return;
      case "interrupt":
        for (const [id] of this.requests) {
          this.io.write({ type: "extension_ui_response", id, cancelled: true });
          this.events.push({ kind: "request_closed", session: this.session, id, running: !!this.turn });
        }
        this.requests.clear();
        this.interrupted = !!this.turn;
        this.abort();
        return;
      case "answer": {
        const d = this.requests.get(input.request);
        if (!d || (d.expires !== null && Date.now() >= d.expires)) throw Error("NoRequest");
        if (input.allow && d.method !== "confirm" && input.message === undefined) throw Error("AnswerRequired");
        if (input.allow && d.method === "select" && !d.options.includes(input.message!)) throw Error("InvalidAnswer");
        this.io.write({
          type: "extension_ui_response",
          id: input.request,
          ...(d.method === "confirm"
            ? { confirmed: input.allow }
            : input.allow
              ? { value: input.message }
              : { cancelled: true }),
        });
        this.requests.delete(input.request);
      }
    }
  }
  decode(v: unknown) {
    const type = str(v, "type");
    const session = this.session;
    switch (type) {
      case "response": {
        if (str(v, "id") === this.awaiting) {
          this.awaiting = "";
          this.flushCommand();
        }
        if (field(v, "success") === false) {
          this.failure = Error("PiRejected: " + str(v, "error"));
          return;
        }
        if (str(v, "id") === "corgi-state") {
          this.session = str(field(v, "data"), "sessionId");
          if (!this.session) {
            this.failure = Error("PiMissingSession");
            return;
          }
          this.events.push({ kind: "conversation", session: this.session, parent: null, role: null, shown: true });
          this.ready = true;
          this.events.push({ kind: "ready" });
        }
        // A slash command or input extension may consume a prompt without a run.
        if (str(v, "command") === "prompt" && str(field(v, "data"), "disposition") === "handled" && !this.turn)
          this.events.push({ kind: "turn", session, turn: "", phase: "ended", outcome: "completed" });
        return;
      }
      case "agent_start":
        if (!this.turn) {
          this.turn = randomUUID();
          this.result = "completed";
          this.interrupted = false;
          this.events.push({ kind: "turn", session, turn: this.turn, phase: "started" });
        }
        return;
      case "message_start":
        this.streamed = [];
        return;
      case "message_update":
        this.stream(v);
        return;
      case "message_end": {
        const m = field(v, "message");
        if (str(m, "role") !== "assistant") return;
        this.streamed = [];
        this.result = outcome(m);
        const text = messageText(m),
          tokens = reported(field(m, "usage"));
        if (text) this.events.push({ kind: "message", session, text });
        if (tokens)
          this.events.push({ kind: "usage", session, turn: this.turn, part: { id: `message-${++this.next}`, tokens } });
        return;
      }
      case "tool_execution_start": {
        const id = str(v, "toolCallId"),
          name = str(v, "toolName"),
          p = str(field(v, "args"), "path");
        this.writes.set(id, ["write", "edit"].includes(name) && p ? [path.resolve(this.cwd, p)] : []);
        this.events.push({
          kind: "tool",
          session,
          turn: this.turn,
          id,
          done: false,
          wrote: [],
          name: toolName(name),
          summary: about(field(v, "args")),
        });
        return;
      }
      case "tool_execution_end": {
        const id = str(v, "toolCallId");
        this.events.push({
          kind: "tool",
          session,
          turn: this.turn,
          id,
          done: true,
          wrote: field(v, "isError") === true ? [] : (this.writes.get(id) ?? []),
        });
        this.writes.delete(id);
        return;
      }
      case "agent_settled":
        this.settled(field(v, "aborted") === true);
        return;
      case "extension_ui_request": {
        const id = str(v, "id"),
          method = str(v, "method");
        if (!id || !["confirm", "select", "input", "editor"].includes(method)) return;
        const options = field(v, "options"),
          timeout = field(v, "timeout");
        const choices = Array.isArray(options) ? options.filter((v): v is string => typeof v === "string") : [];
        this.requests.set(id, {
          method,
          options: choices,
          expires: typeof timeout === "number" ? Date.now() + timeout : null,
        });
        this.events.push({
          kind: "request",
          session,
          id,
          ask: {
            tool: false,
            name: method,
            summary: [str(v, "title"), str(v, "message"), ...choices].filter(Boolean).join("\n"),
          },
        });
        return;
      }
    }
  }
  /** Follows a streaming assistant message: whole, as older versions send
   * it, or as text deltas. */
  stream(v: unknown) {
    const m = field(v, "message");
    if (m !== null) {
      if (str(m, "role") !== "assistant") return;
      const text = messageText(m);
      if (text && text !== this.streamed.join("\n")) {
        this.streamed = [text];
        this.events.push({ kind: "partial", session: this.session, text });
      }
      return;
    }
    const e = field(v, "assistantMessageEvent"),
      index = field(e, "contentIndex"),
      delta = str(e, "delta");
    if (str(e, "type") !== "text_delta" || !delta || !Number.isInteger(index) || index < 0 || index > 1024) return;
    while (this.streamed.length <= index) this.streamed.push("");
    this.streamed[index] += delta;
    this.events.push({ kind: "partial", session: this.session, text: this.streamed.filter(Boolean).join("\n") });
  }
  /** The run is over, with nothing queued that would start another. */
  settled(aborted: boolean) {
    const session = this.session;
    if (this.turn)
      this.events.push({
        kind: "turn",
        session,
        turn: this.turn,
        phase: "ended",
        outcome: aborted || this.interrupted ? "interrupted" : this.result,
      });
    this.turn = "";
    for (const [id] of this.requests) this.events.push({ kind: "request_closed", session, id, running: false });
    this.requests.clear();
    this.writes.clear();
  }
  take() {
    for (const v of this.io.read()) this.decode(v);
    for (const [id, d] of this.requests)
      if (d.expires !== null && Date.now() >= d.expires) {
        this.requests.delete(id);
        this.events.push({ kind: "request_closed", session: this.session, id, running: !!this.turn });
      }
    if (this.failure) {
      const e = this.failure;
      this.failure = null;
      throw e;
    }
    if (this.io.exited && !this.ended) {
      this.events.push({ kind: "ended" });
      this.ended = true;
      this.release();
    }
    const out = this.events;
    this.events = [];
    return out;
  }
  wait(deadline: number) {
    return this.io.wait(deadline);
  }
  close() {
    // A process a handoff passed on may still read it.
    if (this.io.owner === "runtime") this.release();
    this.io.close();
  }
  private release() {
    if (this.file) instructions.remove(this.file);
    this.file = "";
  }
  adopt() {
    this.io.adopt();
  }
  processes() {
    return this.io.pid > 0 ? [this.io.pid] : [];
  }
  save(live: boolean): Saved {
    const s = this.io.save(live);
    return {
      handles: s.handles,
      state: {
        ...(s.state as object),
        cwd: this.cwd,
        ready: this.ready,
        session: this.session,
        turn: this.turn,
        result: this.result,
        interrupted: this.interrupted,
        next: this.next,
        requests: [...this.requests],
        writes: [...this.writes],
        events: this.events,
        ended: this.ended,
        commands: this.commands,
        awaiting: this.awaiting,
        streamed: this.streamed,
        file: this.file,
      },
    };
  }
  static restore(saved: Saved, live: boolean) {
    const s = saved.state as ReturnType<Pi["save"]>["state"] & {
      cwd: string;
      ready: boolean;
      session: string;
      turn: string;
      result: Outcome;
      interrupted: boolean;
      next: number;
      requests: [string, Dialog][];
      writes: [string, string[]][];
      events: Event[];
      ended: boolean;
      commands: Pi["commands"];
      awaiting: string;
      streamed?: string[];
      file?: string;
    };
    const c = new this(Stdio.restore(saved, live), s.cwd);
    Object.assign(c, {
      ready: s.ready,
      session: s.session,
      turn: s.turn,
      result: s.result,
      interrupted: s.interrupted,
      next: s.next,
      ended: live && s.ended,
      commands: s.commands ?? [],
      awaiting: s.awaiting ?? "",
      streamed: s.streamed ?? [],
      file: typeof s.file === "string" ? s.file : "",
    });
    c.requests = new Map(s.requests);
    c.writes = new Map(s.writes);
    c.events = live ? s.events : [];
    return c;
  }
}
