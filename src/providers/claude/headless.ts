//! Claude Code Corgi drives over stream-json: a daemon-hosted session, or a
//! tool-less one for summaries. One conversation per process.
import { parse, stringify } from "../../json";
import { field, number, str } from "../common";
import type { Client, Event, Inference, Input, Place, Saved } from "../adapter";
import { Stdio } from "../stdio";
import { unnest } from "./process";
import { Tokens } from "../../usage/live";
export const stream_json = [
  "--print",
  "--verbose",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--permission-prompt-tool",
  "stdio",
];
// A summary has no tools, MCP servers or saved sessions, and thinks at low effort like Codex's.
const toolless = [
  "--safe-mode",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
  "--no-session-persistence",
  "--effort",
  "low",
];
/** What runs Claude Code as a tool-less model for `r`. */
export function summaryArgs(r: Inference) {
  const args = [...stream_json, ...toolless, "--system-prompt", r.instructions];
  if (r.model) args.push("--model", r.model);
  if (r.schema) args.push("--json-schema", r.schema);
  return args;
}
/** The tokens a message or result reports, cache reads and writes counted as input. */
function reported(usage: unknown) {
  const input = number(usage, "input_tokens"),
    output = number(usage, "output_tokens");
  if (input === null || output === null) return null;
  const cached = number(usage, "cache_read_input_tokens") ?? 0n,
    created = number(usage, "cache_creation_input_tokens") ?? 0n;
  return new Tokens({ input: input + cached + created, cached_input: cached, output });
}
/** What a tool request is about, in a few words. */
function about(input: unknown) {
  for (const key of ["command", "file_path", "pattern", "url", "description"])
    if (str(input, key)) return str(input, key);
  return "";
}
export class Claude implements Client {
  ready: boolean;
  session = "";
  running = false;
  /** The input of each tool waiting on an answer, which an allow sends back. */
  inputs = new Map<string, unknown>();
  next_request = 1;
  /** Results a summary counted. */
  results = 0;
  private events: Event[] = [];
  private failure: Error | null = null;
  constructor(
    readonly io: Stdio,
    /** A summary answers with its result, as JSON when it has a schema. */
    readonly summary: { schema: boolean } | null,
    ready: boolean,
  ) {
    this.ready = ready;
  }
  static start(at: Place, args: string[], summary: { schema: boolean } | null) {
    const env: Record<string, string | undefined> = at.account
      ? { ...process.env, CLAUDE_CONFIG_DIR: at.account }
      : { ...process.env };
    unnest(env);
    const client = new Claude(Stdio.spawn([at.executable, ...args], { cwd: at.cwd, env }), summary, !summary);
    if (summary)
      client.io.write({ type: "control_request", request_id: "corgi-initialize", request: { subtype: "initialize" } });
    return client;
  }
  send(input: Input) {
    switch (input.kind) {
      case "prompt":
        return this.io.write({ type: "user", message: { role: "user", content: input.text } });
      case "answer": {
        if (!this.inputs.has(input.request)) throw Error("NoRequest");
        const tool = this.inputs.get(input.request);
        this.inputs.delete(input.request);
        return this.io.write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: input.request,
            response: input.allow
              ? { behavior: "allow", updatedInput: tool ?? {} }
              : { behavior: "deny", message: input.message || "Denied" },
          },
        });
      }
      case "interrupt":
        return this.io.write({
          type: "control_request",
          request_id: `corgi-interrupt-${this.next_request++}`,
          request: { subtype: "interrupt" },
        });
    }
  }
  private decode(v: unknown) {
    const kind = str(v, "type"),
      session = str(v, "session_id") || this.session;
    if (session && session !== this.session) {
      this.session = session;
      this.events.push({ kind: "conversation", session, parent: null, role: null, shown: true });
    }
    switch (kind) {
      case "assistant": {
        if (!this.running) {
          this.running = true;
          this.events.push({ kind: "turn", session, turn: "", phase: "started" });
        }
        const message = field(v, "message"),
          usage = field(message, "usage");
        // A summary counts what its result reports instead.
        const tokens = this.summary ? null : reported(usage);
        if (str(message, "id") && tokens)
          this.events.push({ kind: "usage", session, turn: "", part: { id: str(message, "id"), tokens } });
        const content = field(message, "content"),
          text: string[] = [];
        for (const block of Array.isArray(content) ? content : []) {
          if (str(block, "type") === "tool_use")
            this.events.push({ kind: "tool", session, turn: "", id: str(block, "id"), done: false, wrote: [] });
          if (str(block, "type") === "text") text.push(str(block, "text"));
        }
        if (text.length && !this.summary) this.events.push({ kind: "message", session, text: text.join("") });
        return;
      }
      case "user": {
        const content = field(field(v, "message"), "content");
        for (const block of Array.isArray(content) ? content : [])
          if (str(block, "type") === "tool_result")
            this.events.push({ kind: "tool", session, turn: "", id: str(block, "tool_use_id"), done: true, wrote: [] });
        return;
      }
      case "result": {
        const subtype = str(v, "subtype"),
          failed = field(v, "is_error") === true || (!!subtype && subtype !== "success");
        const tokens = this.summary ? reported(field(v, "usage")) : null;
        if (tokens)
          this.events.push({ kind: "usage", session, turn: "", part: { id: `result-${++this.results}`, tokens } });
        if (this.summary && !failed) {
          const structured = field(v, "structured_output");
          if (this.summary.schema && structured === null) this.failure = Error("InvalidOutput");
          else
            this.events.push({
              kind: "message",
              session,
              text: this.summary.schema ? stringify(structured) : str(v, "result"),
            });
        }
        this.running = false;
        this.events.push({ kind: "turn", session, turn: "", phase: "ended", outcome: failed ? "failed" : "completed" });
        return;
      }
      case "control_request": {
        const request = field(v, "request"),
          subtype = str(request, "subtype"),
          id = str(v, "request_id");
        if (!id) return;
        if (subtype === "can_use_tool") this.inputs.set(id, field(request, "input"));
        this.events.push({
          kind: "request",
          session,
          id,
          ask: {
            tool: subtype === "can_use_tool",
            name: str(request, "tool_name") || subtype,
            summary: about(field(request, "input")),
          },
        });
        return;
      }
      case "control_response": {
        const response = field(v, "response");
        if (str(response, "request_id") !== "corgi-initialize") return;
        if (str(response, "subtype") !== "success") this.failure = Error("HarnessRejected");
        else {
          this.ready = true;
          this.events.push({ kind: "ready" });
        }
        return;
      }
    }
  }
  take(): Event[] {
    for (const value of this.io.read()) this.decode(value);
    if (this.io.exited) this.events.push({ kind: "ended" });
    const out = this.events;
    this.events = [];
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
    return out;
  }
  wait(deadline: number) {
    return this.io.wait(deadline);
  }
  close() {
    this.io.close();
  }
  adopt() {
    this.io.adopt();
  }
  processes() {
    return this.io.pid > 0 ? [this.io.pid] : [];
  }
  save(live: boolean): Saved {
    const saved = this.io.save(live);
    return {
      state: {
        ...(saved.state as object),
        ready: this.ready,
        session: this.session,
        running: this.running,
        inputs: [...this.inputs],
        results: this.results,
        summary: this.summary,
      },
      handles: saved.handles,
    };
  }
  static restore(saved: Saved, live: boolean) {
    const state: any = saved.state ?? {},
      client = new Claude(Stdio.restore(saved, live), state.summary ?? null, state.ready === true);
    client.session = state.session ?? "";
    client.running = state.running === true;
    client.inputs = new Map(state.inputs ?? []);
    client.results = state.results ?? 0;
    // Requests an older Corgi kept as the lines it read.
    for (const line of state.lines ?? []) client.decode(typeof line === "string" ? parse(line) : line);
    return client;
  }
}
