//! What Claude Code's transcript records count: tokens per message, the
//! context window, tools, and the names and updates it writes down.
import { field, number, str, timestampMs, Text } from "../common";
import { Counts, add, type Tracker } from "../../usage/tokens";
import { Tokens } from "../../usage/live";
import type { Reading } from "../../usage/context_window";
import { Call, clip, shortPath, type Tracker as Tools } from "../../activity/tools";
import { Text as Summary } from "../../activity/summary";
import { Model } from "../model";
import type { TranscriptReader } from "../adapter";
import type { Tail } from "../../usage/worker";
import { Line, TaskNotice } from "./transcript";
/** The tokens and tool calls an assistant message adds. */
export function messageTokens(tracker: Tracker, message: any) {
  let delta = new Counts();
  const id = str(message, "id"),
    usage = field(message, "usage"),
    input = number(usage, "input_tokens"),
    output = number(usage, "output_tokens");
  if (id && input !== null && output !== null) {
    const cached = number(usage, "cache_read_input_tokens") ?? 0n;
    delta = tracker.tokensCached(
      id,
      add(add(input, cached), number(usage, "cache_creation_input_tokens") ?? 0n),
      cached,
      output,
      false,
    );
  }
  if (str(message, "model") !== "<synthetic>") delta.turns = tracker.response(id);
  const content = field(message, "content");
  if (Array.isArray(content))
    for (const block of content)
      if (str(block, "type") === "tool_use") delta.tools = add(delta.tools, tracker.tool(str(block, "id")));
  return delta;
}
/** How full the context window is after a record. */
export function context(r: Reading, value: any) {
  const line = Line.decode(value);
  if (!line) return;
  const turn = line.turn();
  if (turn) r.in_turn = turn === "open";
  const stamp = timestampMs(line.timestamp);
  if (stamp === null) return;
  if (line.type === "assistant") {
    const model = Model.resolve(str(line.message, "model"));
    if (!model.window) return;
    const usage = field(line.message, "usage"),
      input = number(usage, "input_tokens");
    if (input === null) return;
    r.used = add(
      add(input, number(usage, "cache_read_input_tokens") ?? 0n),
      number(usage, "cache_creation_input_tokens") ?? 0n,
    );
    r.window = model.window;
    r.at = stamp;
    r.model = model;
  } else if (line.type === "system" && line.subtype === "compact_boundary") {
    const meta = field(value, "compactMetadata");
    // Claude also compacts an idle session, at any size, before its prompt
    // cache expires; only a compaction inside a turn marks a full window.
    if (str(meta, "trigger") === "auto" && r.in_turn)
      r.auto_compaction = number(meta, "preTokens") ?? r.auto_compaction;
    r.used = number(meta, "postTokens") ?? 0n;
    r.at = stamp;
  }
}
/** The tools a record starts or finishes, and the agent's latest words. */
export function progress(t: Tools, value: any, live: boolean) {
  if (!t.turn.len || t.ended) return;
  const line = Line.decode(value);
  if (!line) return;
  if (line.type === "system" && line.subtype === "turn_duration") {
    if (live) t.ended = true;
    return;
  }
  const content = field(line.message, "content");
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const type = str(block, "type"),
      text = line.commentary(block).trim();
    if (text) {
      t.commentary = new Summary(clip("Latest agent update: " + text, 2048));
      t.dirty = true;
    } else if (line.type === "assistant" && type === "tool_use") {
      const id = str(block, "id");
      if (!id) continue;
      const key = t.key(id);
      if (t.seen.includes(key)) continue;
      const call = new Call();
      call.id = key;
      const name = str(block, "name"),
        input = field(block, "input");
      call.append(name + ": ");
      if (name === "Artifact")
        call.detail([str(input, "action"), str(input, "intent"), str(input, "title")].filter(Boolean).join(" "));
      else
        for (const key of ["description", "command", "file_path", "pattern", "query", "url", "prompt"]) {
          const detail = str(input, key);
          if (!detail) continue;
          call.detail(key === "file_path" ? shortPath(detail) : detail);
          break;
        }
      t.save(call, live);
    } else if (line.type === "user" && type === "tool_result") {
      const id = str(block, "tool_use_id");
      if (id) t.finishId(t.key(id), live);
    }
  }
}
/** The latest thing an assistant message said, one line of it. */
function update(t: Tail, line: Line) {
  const stamp = timestampMs(line.timestamp),
    content = field(line.message, "content");
  if (stamp === null || !Array.isArray(content)) return;
  let latest = "";
  for (const part of content) {
    for (const row of line.commentary(part).split("\n")) {
      const text = row.replace(/^[ \t\r#*\->`_]+|[ \t\r#*\->`_]+$/g, "");
      if (!text) continue;
      latest = text;
      break;
    }
  }
  if (!latest) return;
  t.update = new Text(latest.slice(0, 160));
  t.update_at = stamp * 1000;
}
/** The names, continuation, last words and ended tasks a record notes. */
function notes(t: Tail, session: string, value: any) {
  const line = Line.decode(value);
  if (!line || line.sessionId !== session || !line.type) return;
  const chosen =
      line.type === "agent-name"
        ? str(value, "agentName")
        : line.type === "custom-title"
          ? str(value, "customTitle")
          : "",
    generated = line.type === "ai-title" ? str(value, "aiTitle") : "";
  if (chosen && !chosen.includes("�")) {
    t.name = new Text(chosen.slice(0, 160));
    t.name_chosen = true;
  } else if (generated && !t.name_chosen && !generated.includes("�")) t.name = new Text(generated.slice(0, 160));
  if (line.type === "assistant") update(t, line);
  if (line.type === "continued-in") t.continued = new Text(str(value, "continuedInSessionId"));
  else if (line.type === "user" || line.type === "assistant") {
    t.continued = new Text();
    const stamp = timestampMs(line.timestamp);
    if (stamp !== null) t.spoke_at = Math.max(t.spoke_at, stamp);
  } else if (line.type === "queue-operation" && str(value, "operation") === "enqueue") {
    const notice = TaskNotice.decode(str(value, "content"));
    if (notice?.status) t.ended.add(notice.id);
  }
}
export function open(): TranscriptReader {
  return {
    open(t) {
      t.live.meter.count(0n, 0n);
      if (!t.live.meter.value.known) {
        t.live.meter.value.known = true;
        t.live.meter.value.since = Date.now();
      }
    },
    record(t, req, value, appended, stamp) {
      const session = req.agent.sessionId();
      notes(t, session, value);
      if (str(value, "sessionId") === session) {
        progress(t.progress, value, appended);
        context(t.context, value);
      }
      t.observeModel(field(value, "message"));
      const line = Line.of(value, session),
        delta = line?.type === "assistant" ? messageTokens(t.tracker, line.message) : new Counts(),
        owned = t.catch_up && stamp !== null && stamp >= req.tracked_since;
      if (appended || owned) {
        t.live.meter.count(delta.turns, delta.tools);
        if (delta.tokens_known)
          t.live.meter.add(
            new Tokens({ input: delta.input, cached_input: delta.cached_input, output: delta.output }),
            stamp ?? Date.now(),
          );
      }
      return delta;
    },
  };
}
