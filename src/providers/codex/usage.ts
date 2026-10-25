//! What Codex's rollouts and app server count: running token totals, the
//! context window and tool calls.
import { field, number, str, timestampMs } from "../common";
import { Counts, add, type Tracker } from "../../usage/tokens";
import { Tokens, type Counter } from "../../usage/live";
import type { Reading } from "../../usage/context_window";
import { Call, clip, type Tracker as Tools } from "../../activity/tools";
import { Text } from "../../activity/summary";
import type { TranscriptReader } from "../adapter";
import { Index, Name } from "./files";
import { Rollout } from "./transcript";
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** A token total as the app server (camelCase) or a rollout (snake_case) spells it. */
export function parseTokens(v: any, camel: boolean) {
  const input = number(v, camel ? "inputTokens" : "input_tokens"),
    output = number(v, camel ? "outputTokens" : "output_tokens");
  if (input === null || output === null) return null;
  return new Tokens({
    input,
    cached_input: min(input, number(v, camel ? "cachedInputTokens" : "cached_input_tokens") ?? 0n),
    output,
  });
}
/** What a thread's running total adds since the last one. */
export function totalTokens(tracker: Tracker, id: string, total: any, camel: boolean) {
  const input = number(total, camel ? "inputTokens" : "input_tokens"),
    output = number(total, camel ? "outputTokens" : "output_tokens");
  return input === null || output === null ? new Counts() : tracker.tokens(id, input, output, true);
}
/** What an app server's `thread/tokenUsage/updated` adds; the first report of
 * a turn already running counts its last request. */
export function notificationTokens(tracker: Tracker, id: string, value: any, active: boolean) {
  const known = tracker.hasSample(id),
    delta = totalTokens(tracker, id, field(value, "total"), true);
  if (!known && active && delta.tokens_known) {
    const last = field(value, "last");
    delta.input = number(last, "inputTokens") ?? 0n;
    delta.output = number(last, "outputTokens") ?? 0n;
  }
  return delta;
}
/** Readies `c` from a rollout's first record: a subagent's rollout copies its
 * parent's history, which it owns only from an ordinal on. */
export function header(c: Counter, value: any, child: boolean, tracked_since: number, complete_prefix: boolean) {
  c.child = child;
  const r = Rollout.decode(value);
  c.owned_from = number(r.payload, "subagent_history_start_ordinal");
  const created = timestampMs(str(r.payload, "timestamp")) ?? timestampMs(r.timestamp);
  c.catch_up =
    child &&
    complete_prefix &&
    c.owned_from !== null &&
    created !== null &&
    tracked_since > 0 &&
    created >= tracked_since;
  if (child && (!c.catch_up || c.owned_from === null)) c.meter.lose();
}
/** Counts a rollout's `token_count` record into `c`. */
export function rolloutTokens(c: Counter, value: any, appended: boolean, now: number) {
  const r = Rollout.decode(value);
  if (r.type !== "event_msg" || r.payloadType() !== "token_count") return;
  const ordinal = number(value, "ordinal");
  if (c.owned_from !== null) {
    if (ordinal === null) {
      c.meter.lose();
      return;
    }
    if (ordinal < c.owned_from) return;
  }
  if (ordinal !== null) {
    if (c.ordinal !== null && ordinal <= c.ordinal) return;
    c.ordinal = ordinal;
  }
  const info = field(r.payload, "info"),
    total = parseTokens(field(info, "total_token_usage"), false);
  if (!total) return;
  c.sample(
    total,
    parseTokens(field(info, "last_token_usage"), false),
    appended || c.catch_up,
    Math.min(timestampMs(r.timestamp) ?? now, now),
    true,
  );
}
/** Counts an app server's token report into `c`. */
export function headlessTokens(c: Counter, value: any, active: boolean, now: number) {
  const total = parseTokens(field(value, "total"), true);
  if (total) c.sample(total, parseTokens(field(value, "last"), true), active, now, true);
}
/** How full the context window is after a record. */
export function context(r: Reading, value: any) {
  const rollout = Rollout.decode(value);
  if (rollout.type !== "event_msg" || rollout.payloadType() !== "token_count") return;
  const stamp = timestampMs(rollout.timestamp),
    info = field(rollout.payload, "info"),
    window = number(info, "model_context_window"),
    last = field(info, "last_token_usage");
  if (stamp === null || window === null) return;
  let used = number(last, "total_tokens");
  if (used === null) {
    const input = number(last, "input_tokens");
    if (input === null) return;
    used = add(input, number(last, "output_tokens") ?? 0n);
  }
  r.used = used;
  r.window = window;
  r.at = stamp;
}
/** The tools a record starts or finishes, and the agent's commentary. */
export function progress(t: Tools, value: any, live: boolean) {
  const r = Rollout.decode(value),
    kind = r.type,
    p = r.payload,
    type = r.payloadType();
  if (kind === "turn_context" || (kind === "event_msg" && type === "task_started")) {
    t.bind(str(p, "turn_id"));
    return;
  }
  if (kind === "event_msg" && ["task_complete", "turn_complete", "turn_aborted"].includes(type ?? "")) {
    const turn = str(p, "turn_id");
    if (!turn || turn === t.turn.text()) t.ended = true;
    return;
  }
  if (kind !== "response_item" || !t.turn.len || t.ended) return;
  if (type === "message" && str(p, "role") === "assistant" && str(p, "phase") === "commentary") {
    const content = field(p, "content");
    if (Array.isArray(content)) {
      t.commentary = new Text(
        clip(
          "Latest agent update: " +
            content
              .filter(c => str(c, "type") === "output_text")
              .map(c => str(c, "text"))
              .join(""),
          2048,
        ),
      );
      t.dirty = true;
    }
    return;
  }
  const id = str(p, "call_id") || str(p, "id");
  if (!id) return;
  const key = t.key(id);
  if (t.seen.includes(key)) return;
  if (["function_call_output", "custom_tool_call_output"].includes(type ?? "")) {
    t.finishId(key, live);
    return;
  }
  if (!["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(type ?? "")) return;
  const call = new Call();
  call.id = key;
  call.append((str(p, "name") || type) + ": ");
  const input = str(p, "arguments") || str(p, "input");
  if (input) {
    try {
      const args = JSON.parse(input),
        detail = ["description", "cmd", "command", "code", "query"].map(k => str(args, k)).find(Boolean) ?? input;
      call.detail(detail);
    } catch {
      const start = Buffer.byteLength(call.value);
      if (input.trimStart().startsWith("*** Begin Patch") && call.patchFiles(input)) call.bound(start, false);
      else if (!call.script(input)) call.detail(input);
    }
  } else if (type === "web_search_call") call.detail(str(field(p, "action"), "query"));
  if (type === "web_search_call" && str(p, "status") === "completed") {
    t.finish(call, live);
    return;
  }
  t.save(call, live);
}
/** The tokens and tool calls a rollout record adds. */
function counts(tracker: Tracker, value: any) {
  const r = Rollout.decode(value),
    kind = r.payloadType();
  if (r.type === "event_msg" && kind === "token_count")
    return totalTokens(tracker, "codex", field(field(r.payload, "info"), "total_token_usage"), false);
  if (
    r.type === "response_item" &&
    ["function_call", "custom_tool_call", "web_search_call", "local_shell_call"].includes(kind ?? "")
  )
    return new Counts({ tools: tracker.tool(str(r.payload, "call_id") || str(r.payload, "id")) });
  return new Counts();
}
/** A reader that names threads from `index`, the session index Codex keeps. */
/** A reader that names sessions from the session indexes at `indexes`. */
export function open(indexes: () => string[]): TranscriptReader {
  const found = new Map<string, Index>(),
    index = (file: string) => {
      let names = found.get(file);
      if (!names) found.set(file, (names = new Index()));
      return names;
    };
  return {
    refresh: async () => void (await Promise.all(indexes().map(file => index(file).refreshAsync(file)))),
    open(t, req, head, catch_up) {
      t.live.meter.count(0n, 0n);
      if (head !== null) header(t.live, head, req.child, req.tracked_since, catch_up);
      else if (req.child) t.live.meter.lose();
      t.progress.bind(req.agent.turnId());
      if (!t.offset) t.tracker.tokens("codex", 0n, 0n, true);
    },
    record(t, _req, value, appended) {
      progress(t.progress, value, appended);
      t.observeModel(field(value, "payload"));
      const delta = counts(t.tracker, value);
      const ordinal = number(value, "ordinal"),
        owned = t.live.owned_from === null || (ordinal !== null && ordinal >= t.live.owned_from);
      if (owned && (appended || t.live.catch_up)) t.live.meter.count(0n, delta.tools);
      rolloutTokens(t.live, value, appended, Date.now());
      context(t.context, value);
      return delta;
    },
    name(session) {
      for (const names of found.values()) {
        const name = names.name(session);
        if (name.len) return name;
      }
      return new Name();
    },
    close: () => found.forEach(names => names.close()),
  };
}
