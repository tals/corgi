import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { Event } from "../../src/activity/plan";
export type { Event } from "../../src/activity/plan";

export type Provider = "codex" | "claude";
export type Kind = Event["kind"];
export type Tokens = { input: string; cached: string; output: string };
export type Receipt = { id: string; event: number | null; line: number; tokens: Tokens };
export type Activity = { line: number; running: boolean };
export type History = {
  provider: Provider;
  source: string;
  sha256: string;
  accounting_hash?: string;
  events: Event[];
  receipts: Receipt[];
  activity?: Activity[];
  warnings: string[];
};
export const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const string = (v: unknown) => (typeof v === "string" ? v : "");
export const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (v: unknown) => {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw Error("InvalidTokenCount");
};
export const zero = (): Tokens => ({ input: "0", cached: "0", output: "0" });
export function add(a: Tokens, b: Tokens): Tokens {
  return {
    input: String(BigInt(a.input) + BigInt(b.input)),
    cached: String(BigInt(a.cached) + BigInt(b.cached)),
    output: String(BigInt(a.output) + BigInt(b.output)),
  };
}
export const total = (t: Tokens) => BigInt(t.input) + BigInt(t.output);
export const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function usage(value: unknown, provider: Provider): Tokens {
  const v = object(value),
    cached = count(v[provider === "claude" ? "cache_read_input_tokens" : "cached_input_tokens"] ?? 0);
  const input =
    count(v.input_tokens) + (provider === "claude" ? cached + count(v.cache_creation_input_tokens ?? 0) : 0n);
  if (cached > input) throw Error("InvalidCachedCount");
  return { input: String(input), cached: String(cached), output: String(count(v.output_tokens)) };
}
function clip(s: string) {
  return s.length <= 1800 ? s : s.slice(0, 1200) + "\n[excerpt omitted]\n" + s.slice(-600);
}
function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value)
    .map(v => string(object(v).text))
    .filter(Boolean)
    .join("\n");
}

/** Offline replay boundary. Never executes transcript commands. */
export function read(source: string, provider: Provider): History {
  return decode(fs.readFileSync(source, "utf8"), provider, source);
}

/** Supplement old frozen replays without changing their evidence or accounting. */
export function activity(data: History): Activity[] {
  if (data.activity) return data.activity;
  if (!fs.existsSync(data.source)) return [];
  return decode(fs.readFileSync(data.source, "utf8"), data.provider, data.source).activity!;
}
export function runningAt(activity: Activity[], throughLine: number): boolean | null {
  return activity.findLast(a => a.line <= throughLine)?.running ?? null;
}

/** Recompute accounting without changing the evidence a recorded run saw. */
export function reaccount(data: History): History {
  const last = Math.max(0, ...data.events.map(e => e.line), ...data.receipts.map(r => r.line));
  const raw = fs.readFileSync(data.source, "utf8").split("\n").slice(0, last).join("\n");
  const fresh = decode(raw, data.provider, data.source);
  if (JSON.stringify(fresh.events) !== JSON.stringify(data.events)) throw Error("SourceEvidenceChanged");
  return {
    ...data,
    receipts: fresh.receipts,
    accounting_hash: hash(fs.readFileSync(import.meta.path, "utf8")),
    warnings: [...new Set([...data.warnings, ...fresh.warnings])],
  };
}
export function decode(raw: string, provider: Provider, source = "fixture"): History {
  const records = raw.split("\n").map(line => (line.trim() ? object(JSON.parse(line)) : {}));
  const history: History = { provider, source, sha256: hash(raw), events: [], receipts: [], warnings: [] };
  const activity: Activity[] = [];
  history.activity = activity;
  const running = (value: boolean, line: number) => {
    if (activity.at(-1)?.running !== value) activity.push({ line, running: value });
  };
  const meta = records.find(v => v.type === "session_meta"),
    metadata = object(meta?.payload),
    fork = provider === "codex" && Boolean(metadata.forked_from_id),
    owner = string(metadata.id),
    since = string(metadata.timestamp),
    owned =
      fork &&
      Boolean(owner && since) &&
      records.some(v => v.type === "token_usage_record" && object(v.payload).session_id === owner);
  if (owned) history.warnings.push("Fork suffix only: inherited events and other sessions' receipts excluded.");
  const direct = records.some(v => v.type === "token_usage_record");
  const seen = new Set<string>(),
    counters = new Map<string, Tokens>(),
    responseAnchors = new Map<string, number | null>(),
    receiptGroups = new Map<string, Receipt[]>();
  let turn = 0,
    codexTurn = "",
    anchor: number | null = null,
    hasCumulative = false,
    cumulative = zero();
  const emit = (kind: Kind, text: string, line: number, at: string) => {
    if (!text.trim()) return;
    if (kind === "user") turn++;
    const event = { id: history.events.length + 1, line, at, turn, kind, text: clip(text) };
    history.events.push(event);
    if (["user", "assistant", "reasoning", "tool", "plan", "result"].includes(kind)) running(true, line);
    if (["assistant", "reasoning", "tool", "plan"].includes(kind)) anchor = event.id;
    if (kind === "user") anchor = null;
  };
  const receipt = (id: string, value: Tokens, line: number) => {
    if (provider === "codex" && !responseAnchors.has(id)) responseAnchors.set(id, anchor);
    const old = counters.get(id) ?? zero(),
      delta = zero();
    for (const key of ["input", "cached", "output"] as const) {
      const next = BigInt(value[key]),
        previous = BigInt(old[key]);
      delta[key] = String(next > previous ? next - previous : 0n);
      old[key] = String(next > previous ? next : previous);
    }
    counters.set(id, old);
    if (total(delta) || BigInt(delta.cached)) {
      const entry = {
        id: `${id}:${line}`,
        event: responseAnchors.get(id) ?? null,
        line,
        tokens: delta,
      };
      history.receipts.push(entry);
      const group = receiptGroups.get(id) ?? [];
      group.push(entry);
      receiptGroups.set(id, group);
    }
  };
  for (const [index, v] of records.entries()) {
    const line = index + 1,
      at = string(v.timestamp),
      p = object(v.payload),
      m = object(v.message);
    if (provider === "codex") {
      if (owned && (!at || at < since)) continue;
      if (v.type === "turn_context" || (v.type === "event_msg" && p.type === "task_started")) {
        if (v.type === "event_msg") running(true, line);
        const id = string(p.turn_id);
        if (id !== codexTurn) anchor = null;
        codexTurn = id;
      }
      if (v.type === "session_meta" && ((p.forked_from_id && !owned) || object(p.source).subagent))
        history.warnings.push("Fork/child history: inherited usage must be excluded before adding to parent totals.");
      if (v.type === "response_item") {
        const type = string(p.type),
          role = string(p.role);
        if (type === "message" && (role === "assistant" || role === "user")) {
          const text = blockText(p.content);
          if (!/^(# AGENTS|<environment_context|<INSTRUCTIONS|<codex_internal_context)/.test(text))
            emit(role, text, line, at);
        } else if (type === "reasoning") {
          emit("reasoning", blockText(p.summary) || blockText(p.content), line, at);
        } else if (type === "function_call" || type === "custom_tool_call") {
          const id = string(p.call_id);
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          const name = string(p.name),
            text = `${name}: ${string(p.arguments) || string(p.input)}`;
          emit(/update_plan|TodoWrite|Task(Create|Update)/.test(name) ? "plan" : "tool", text, line, at);
        } else if (type === "function_call_output" || type === "custom_tool_call_output") {
          emit("result", blockText(p.output) || JSON.stringify(p.output ?? null), line, at);
        } else if (type === "agent_message") {
          emit("assistant", "Delegated agent report: " + (blockText(p.content) || string(p.text)), line, at);
        }
      } else if (v.type === "token_usage_record") {
        if (owned && p.session_id !== owner) continue;
        const id = string(p.response_id);
        if (!id) throw Error("MissingResponseIdentity");
        if (codexTurn && string(p.turn_id) && p.turn_id !== codexTurn && !responseAnchors.has(id))
          responseAnchors.set(id, null);
        receipt(id, usage(p.usage, provider), line);
      } else if (v.type === "event_msg" && p.type === "token_count" && !direct) {
        const info = object(p.info);
        if (!info.total_token_usage) continue;
        const current = usage(info.total_token_usage, provider);
        if (!hasCumulative) {
          hasCumulative = true;
          const last = info.last_token_usage ? usage(info.last_token_usage, provider) : zero();
          if (total(last) !== total(current))
            history.warnings.push(`Partial opening counter at line ${line}; earlier usage is excluded.`);
          receipt(`cumulative:${line}`, last, line);
          cumulative = current;
          continue;
        }
        if (BigInt(current.input) < BigInt(cumulative.input) || BigInt(current.output) < BigInt(cumulative.output)) {
          history.warnings.push(`Counter reset at line ${line}; usage after reset is incomplete.`);
          cumulative = current;
          continue;
        }
        const delta = zero();
        for (const key of ["input", "cached", "output"] as const)
          delta[key] = String(
            BigInt(current[key]) > BigInt(cumulative[key]) ? BigInt(current[key]) - BigInt(cumulative[key]) : 0n,
          );
        receipt(`cumulative:${line}`, delta, line);
        cumulative = current;
      } else if (
        v.type === "event_msg" &&
        ["task_complete", "turn_aborted", "turn_complete"].includes(string(p.type))
      ) {
        emit("lifecycle", string(p.type), line, at);
        if (!codexTurn || !p.turn_id || p.turn_id === codexTurn) {
          anchor = null;
          running(false, line);
        }
      } else if (v.type === "compacted") {
        const id = string(p.compaction_response_id);
        if (id) {
          responseAnchors.set(id, null);
          for (const entry of receiptGroups.get(id) ?? []) entry.event = null;
        }
        anchor = null;
        emit("lifecycle", "Context compacted; retain existing goals and episodes.", line, at);
      }
    } else {
      if (v.isSidechain) history.warnings.push("Child transcript; parent usage is not included.");
      if (v.type === "assistant" || v.type === "user") {
        const first = history.events.length;
        const contents = typeof m.content === "string" ? [{ type: "text", text: m.content }] : array(m.content);
        for (const item of contents) {
          const b = object(item),
            type = string(b.type);
          const key = `${string(m.id) || string(v.uuid)}:${hash(JSON.stringify(b))}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (type === "text") {
            const text = string(b.text);
            const role =
              v.type === "assistant"
                ? "assistant"
                : /^(<task-notification>|\[Request interrupted|This session is being continued|Another Claude session)/.test(
                      text,
                    )
                  ? "lifecycle"
                  : "user";
            emit(role, text, line, at);
          } else if (type === "thinking") emit("reasoning", string(b.thinking), line, at);
          else if (type === "tool_use") {
            const name = string(b.name);
            emit(
              /TodoWrite|Task(Create|Update)/.test(name) ? "plan" : "tool",
              `${name}: ${JSON.stringify(b.input)}`,
              line,
              at,
            );
          } else if (type === "tool_result")
            emit(
              "result",
              `Tool ${string(b.tool_use_id)}${b.is_error === true ? " [failure]" : " [outcome from result]"}: ${blockText(b.content)}`,
              line,
              at,
            );
        }
        if (v.type === "assistant" && string(m.id)) {
          const id = string(m.id),
            generated = history.events.slice(first);
          const concrete =
            generated.find(e => e.kind === "tool" || e.kind === "plan") ?? generated.find(e => e.kind === "assistant");
          if (!responseAnchors.has(id) && concrete) {
            responseAnchors.set(id, concrete.id);
            // A thinking block can report usage before its tool block arrives.
            for (const entry of receiptGroups.get(id) ?? []) entry.event = concrete.id;
          }
          if (m.usage) receipt(id, usage(m.usage, provider), line);
        }
        if (v.type === "assistant" && ["end_turn", "stop_sequence"].includes(string(m.stop_reason)))
          running(false, line);
      } else if (v.type === "system" && ["compact_boundary", "turn_duration"].includes(string(v.subtype))) {
        emit("lifecycle", string(v.subtype), line, at);
        if (v.subtype === "turn_duration") running(false, line);
      }
    }
  }
  history.warnings = [...new Set(history.warnings)];
  if (!history.receipts.length) history.warnings.push("No usage receipts; tokens are unknown, not zero.");
  history.warnings.push(
    "Episode usage follows the generating response/action; a response spanning steps is approximate. Child usage is excluded.",
  );
  return history;
}
