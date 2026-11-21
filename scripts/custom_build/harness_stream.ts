import type { HarnessKind } from "./config";

/** The harness command with the flag that makes its kind stream JSON events,
 * unless the command already chooses an output format. */
export function harnessArgs(command: string[], kind: HarnessKind | undefined): string[] {
  switch (kind) {
    case "claude":
      if (command.includes("--output-format")) return command;
      return [...command, "--output-format", "stream-json", "--verbose"];
    case "codex": {
      if (command.includes("--json")) return command;
      const exec = command.indexOf("exec");
      if (exec < 0) return [...command, "--json"];
      return [...command.slice(0, exec + 1), "--json", ...command.slice(exec + 1)];
    }
    default:
      return command;
  }
}

/** Tokens a harness call used, in and out. Claude: in = input + cache creation +
 * cache read tokens. Codex: in = input_tokens, which already includes its
 * cached input. Out = output tokens for both. */
export type Usage = { input: number; output: number };

/** What one chunk of harness output said: readable lines for the log and the
 * latest one-line activity (null when the chunk had none). */
export type Parsed = { text: string[]; activity: string | null };

export interface StreamParser {
  /** Parse the complete lines in the chunk; a partial last line waits for the next chunk. */
  feed(chunk: string): Parsed;
  /** Summed usage of all usage events so far, or null when none came. */
  usage(): Usage | null;
}

type Json = Record<string, unknown>;

/** A parser for the JSON lines of a harness kind's output. Unknown JSON events
 * are ignored; lines that are not JSON objects pass through as text. */
export function streamParser(kind: HarnessKind): StreamParser {
  let buffer = "";
  let total: Usage | null = null;
  const seen = new Set<string>();

  const addUsage = (input: number, output: number) => {
    total = { input: (total?.input ?? 0) + input, output: (total?.output ?? 0) + output };
  };

  const claudeEvent = (event: Json, out: Parsed) => {
    if (event.type === "assistant") {
      const content = obj(event.message)?.content;
      for (const item of Array.isArray(content) ? content : []) {
        const part = obj(item);
        if (part?.type === "text") say(out, str(part.text));
        if (part?.type === "tool_use") {
          const input = obj(part.input);
          const target = [input?.file_path, input?.command, input?.pattern].find(v => typeof v === "string");
          act(out, `${str(part.name)} ${oneLine(str(target))}`.trim());
        }
      }
    } else if (event.type === "result") {
      const u = obj(event.usage);
      if (u)
        addUsage(
          num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
          num(u.output_tokens),
        );
    }
  };

  const codexEvent = (event: Json, out: Parsed) => {
    const type = str(event.type);
    if (type.startsWith("item.")) {
      const item = obj(event.item);
      if (!item) return;
      // Codex reports an item when it starts and again when it completes; show it once.
      const id = typeof item.id === "string" ? item.id : null;
      if (id !== null && seen.has(id)) return;
      const before = out.text.length;
      if (item.type === "agent_message") say(out, str(item.text));
      else if (item.type === "command_execution") act(out, oneLine(str(item.command)));
      else if (item.type === "file_change") {
        const first = obj(Array.isArray(item.changes) ? item.changes[0] : undefined);
        act(out, `edit ${str(first?.path)}`.trim());
      }
      if (id !== null && out.text.length > before) seen.add(id);
    } else if (type === "turn.completed") {
      const u = obj(event.usage);
      // input_tokens already counts cached_input_tokens, so the cache is not added again.
      if (u) addUsage(num(u.input_tokens), num(u.output_tokens));
    }
  };

  const line = (raw: string, out: Parsed) => {
    const text = raw.replace(/\r$/, "");
    if (text.trim() === "") return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      event = undefined;
    }
    const json = obj(event);
    if (!json) return say(out, text);
    if (kind === "claude") claudeEvent(json, out);
    else codexEvent(json, out);
  };

  return {
    feed(chunk) {
      const out: Parsed = { text: [], activity: null };
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) line(raw, out);
      return out;
    },
    usage: () => total,
  };
}

/** Text lines go to the log; the last one is the activity. */
function say(out: Parsed, text: string) {
  for (const l of text.split("\n")) {
    const trimmed = l.trimEnd();
    if (trimmed.trim() === "") continue;
    out.text.push(trimmed);
    out.activity = trimmed.trim();
  }
}

/** A tool or command: logged with an arrow, and the activity. */
function act(out: Parsed, what: string) {
  if (what === "") return;
  out.text.push(`→ ${what}`);
  out.activity = what;
}

function oneLine(s: string): string {
  return (
    s
      .split("\n")
      .find(l => l.trim() !== "")
      ?.trim() ?? ""
  );
}

function obj(v: unknown): Json | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
