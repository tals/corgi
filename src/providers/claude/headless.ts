//! Claude Code Corgi drives over stream-json: a daemon-hosted session, or a
//! tool-less one for summaries. One conversation per process.
import { parse, stringify } from "../../json";
import { field, imageData, number, str } from "../common";
import type { Client, Event, Inference, Input, Place, Saved } from "../adapter";
import { Stdio } from "../stdio";
import * as instructions from "../instructions";
import { Tokens } from "../../usage/live";
const stream_json = [
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
/** What runs a daemon-hosted session at `at`, streaming its messages as
 * they're written; `file` holds its instructions. */
export function sessionArgs(at: Place, file: string) {
  const args = [...stream_json, "--include-partial-messages"];
  if (at.model) args.push("--model", at.model);
  if (at.effort) args.push("--effort", at.effort);
  if (file) args.push("--append-system-prompt-file", file);
  if (at.persist === false) args.push("--no-session-persistence");
  // Auto mode, and leave to skip the checks should the account not have it.
  if (at.unattended) args.push("--permission-mode", "auto", "--allow-dangerously-skip-permissions");
  return args;
}
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
  for (const key of ["command", "file_path", "notebook_path", "pattern", "url", "query", "description", "skill"])
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
  /** The text block streaming now, so far. */
  streamed = "";
  /** The file its instructions are in, which goes with it. */
  file = "";
  /** It runs without asking: a session that didn't start in auto mode skips its checks. */
  unattended = false;
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
    const client = new Claude(
      Stdio.spawn([at.executable, ...args], {
        cwd: at.cwd,
        env:
          at.account || at.env
            ? { ...process.env, ...at.env, ...(at.account ? { CLAUDE_CONFIG_DIR: at.account } : {}) }
            : undefined,
      }),
      summary,
      !summary,
    );
    if (summary)
      client.io.write({ type: "control_request", request_id: "corgi-initialize", request: { subtype: "initialize" } });
    return client;
  }
  /** A daemon-hosted session at `at`. */
  static session(at: Place) {
    const file = at.instructions ? instructions.write(at.instructions) : "";
    try {
      const client = Claude.start(at, sessionArgs(at, file), null);
      client.file = file;
      client.unattended = at.unattended === true;
      return client;
    } catch (error) {
      instructions.remove(file);
      throw error;
    }
  }
  send(input: Input) {
    switch (input.kind) {
      case "prompt":
        return this.io.write({
          type: "user",
          message: {
            role: "user",
            // Images go along as content blocks after the text.
            content: input.images?.length
              ? [
                  ...(input.text ? [{ type: "text", text: input.text }] : []),
                  ...input.images.map(image => ({
                    type: "image",
                    source: { type: "base64", media_type: image.mime, data: imageData(image) },
                  })),
                ]
              : input.text,
          },
        });
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
      case "system":
        if (this.unattended && str(v, "subtype") === "init") this.unattend(str(v, "permissionMode"));
        return;
      case "stream_event": {
        // A subagent's stream would interleave with the conversation's own.
        if (this.summary || str(v, "parent_tool_use_id")) return;
        this.begin(session);
        const event = field(v, "event"),
          delta = field(event, "delta");
        switch (str(event, "type")) {
          case "message_start":
          case "content_block_start":
            this.streamed = "";
            return;
          case "content_block_delta":
            if (str(delta, "type") !== "text_delta" || !str(delta, "text")) return;
            this.streamed += str(delta, "text");
            this.events.push({ kind: "partial", session, text: this.streamed });
            return;
        }
        return;
      }
      case "assistant": {
        this.begin(session);
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
            this.events.push({
              kind: "tool",
              session,
              turn: "",
              id: str(block, "id"),
              done: false,
              wrote: [],
              name: str(block, "name"),
              summary: about(field(block, "input")),
            });
          if (str(block, "type") === "text") text.push(str(block, "text"));
        }
        // A subagent's text is its own report, not the conversation's reply.
        if (text.length && !this.summary && !str(v, "parent_tool_use_id")) {
          this.streamed = "";
          this.events.push({ kind: "message", session, text: text.join("") });
        }
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
        // An interrupted stream still ends in the message it showed.
        if (this.streamed) this.events.push({ kind: "message", session, text: this.streamed });
        this.streamed = "";
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
  /** Auto mode isn't on for every account and model: without it, skip the checks. */
  private unattend(mode: string) {
    if (mode === "auto" || mode === "bypassPermissions") return;
    this.io.write({
      type: "control_request",
      request_id: `corgi-mode-${this.next_request++}`,
      request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
    });
  }
  private begin(session: string) {
    if (this.running) return;
    this.running = true;
    this.events.push({ kind: "turn", session, turn: "", phase: "started" });
  }
  take(): Event[] {
    for (const value of this.io.read()) this.decode(value);
    if (this.io.exited) {
      this.events.push({ kind: "ended" });
      this.release();
    }
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
        streamed: this.streamed,
        file: this.file,
        unattended: this.unattended,
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
    client.streamed = state.streamed ?? "";
    client.file = typeof state.file === "string" ? state.file : "";
    client.unattended = state.unattended === true;
    // Requests an older Corgi kept as the lines it read.
    for (const line of state.lines ?? []) client.decode(typeof line === "string" ? parse(line) : line);
    return client;
  }
}
