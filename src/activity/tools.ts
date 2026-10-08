import { field, str } from "../providers/common";
import { Text } from "./summary";
import { BoundedText } from "../bounded_text";
class Turn extends BoundedText(160) {}
import { Codex } from "../providers/codex";
import { Claude } from "../providers/claude";
export class View {
  commentary = new Text();
  running = 0;
  ended = false;
  turn = new Turn();
  completed = 0n;
  evidence = new Text();
}
function clip(value: string, limit: number) {
  const b = Buffer.from(value);
  if (b.length <= limit) return value;
  let end = limit;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString();
}
export function shortPath(path: string) {
  const last = path.lastIndexOf("/"),
    parent = path.lastIndexOf("/", last - 1);
  return parent < 0 ? path : path.slice(parent + 1);
}
export function scriptString(args: string, key: string): string | null {
  let from = 0;
  while (true) {
    const at = args.indexOf(key, from);
    if (at < 0) return null;
    from = at + key.length;
    let i = from;
    if (args[i] === '"') i++;
    while (args[i] === " ") i++;
    if (args[i++] !== ":") continue;
    while (args[i] === " ") i++;
    if (!['"', "'", "`"].includes(args[i])) continue;
    const quote = args[i++],
      start = i;
    while (i < args.length && args[i] !== quote) {
      if (args[i] === "\\") i++;
      i++;
    }
    return args.slice(start, i);
  }
}
export class Call {
  id = 0n;
  live = false;
  value = "";
  text() {
    return this.value;
  }
  append(v: string) {
    this.value = clip(this.value + v, 240);
  }
  bound(start: number, dropped: boolean) {
    if (Buffer.byteLength(this.value) > start + 120) this.value = clip(this.value, start + 117);
    else if (!dropped) return;
    this.append("…");
  }
  detail(v: string) {
    const start = Buffer.byteLength(this.value),
      trimmed = v.trim(),
      line = trimmed.split(/[\r\n]/, 1)[0];
    this.append(line.trimEnd());
    this.bound(start, line.length < trimmed.length);
  }
  patchFiles(patch: string) {
    let found = false;
    for (const match of patch.matchAll(/\*\*\* (?:Update File: |Add File: |Delete File: )([^\\\n"'`]+)/g)) {
      if (found) this.append(", ");
      this.append(shortPath(match[1]));
      found = true;
    }
    return found;
  }
  appendScriptLine(raw: string) {
    const line = raw
      .split(/[\r\n]/, 1)[0]
      .split(/\\[nr]/, 1)[0]
      .replace(/\\t/g, " ")
      .replace(/\\(.)/g, "$1");
    this.append(clip(line.trim(), 128));
  }
  script(code: string) {
    const start = Buffer.byteLength(this.value);
    let found = false,
      rest = code;
    while (true) {
      const at = rest.indexOf("tools.");
      if (at < 0 || Buffer.byteLength(this.value) >= start + 120) break;
      rest = rest.slice(at + 6);
      const name = rest.match(/^[A-Za-z0-9_]+/)?.[0];
      if (!name) continue;
      rest = rest.slice(name.length);
      const end = rest.indexOf("tools."),
        args = end < 0 ? rest : rest.slice(0, end);
      if (found) this.append("; ");
      found = true;
      if (name === "exec_command") {
        const cmd = scriptString(args, "cmd");
        if (cmd !== null) this.appendScriptLine(cmd);
        else this.append(name);
      } else if (name === "apply_patch") {
        this.append("apply_patch ");
        this.patchFiles(args);
      } else this.append(name);
    }
    if (found) this.bound(start, rest.includes("tools."));
    return found;
  }
}
export class Tracker {
  commentary = new Text();
  turn = new Turn();
  ended = false;
  completed = 0n;
  pending: Array<Call | null> = Array(64).fill(null);
  next_pending = 0;
  seen: bigint[] = [];
  recent: Array<Call | null> = [null, null, null];
  dirty = false;
  bind(turn: string) {
    if (!turn || turn === this.turn.text() || Buffer.byteLength(turn) > 160) return;
    Object.assign(this, new Tracker());
    this.turn = new Turn(turn);
    this.dirty = true;
  }
  view() {
    const out = new View();
    out.turn = this.turn;
    out.completed = this.completed;
    out.commentary = this.commentary;
    out.ended = this.ended;
    let evidence = "",
      active = 0;
    if (!this.ended)
      for (const call of this.pending) {
        if (!call) continue;
        out.running++;
        if (!call.live || call.text() === this.recent[2]?.text()) continue;
        if (!active) evidence += "Currently running tools (not yet completed):\n";
        if (active < 4) evidence += call.text() + "\n";
        active++;
      }
    if (active > 4) evidence += "Additional tools are running.\n";
    if (this.completed) evidence += "Recent completed tools (oldest to newest):\n";
    for (const call of this.recent) if (call) evidence += call.text() + "\n";
    out.evidence = new Text(clip(evidence, 2048));
    return out;
  }
  key(id: string) {
    return Bun.hash.wyhash(id, 0n) | 1n;
  }
  save(call: Call, live: boolean) {
    let slot = this.pending.findIndex(p => p?.id === call.id);
    if (slot < 0) {
      slot = this.next_pending;
      this.next_pending = (this.next_pending + 1) % 64;
    }
    const old = this.pending[slot];
    call.live = live || (old?.id === call.id && old.live) || false;
    if ((!old || old.text() !== call.text() || old.live !== call.live) && call.live) this.dirty = true;
    this.pending[slot] = call;
  }
  finish(call: Call, live: boolean) {
    if (this.seen.length === 256) this.seen.shift();
    this.seen.push(call.id);
    if (!live) return;
    this.completed++;
    this.dirty = true;
    if (this.recent[2]?.text() !== call.text()) {
      this.recent[0] = this.recent[1];
      this.recent[1] = this.recent[2];
    }
    this.recent[2] = call;
  }
  finishId(id: bigint, live: boolean) {
    const slot = this.pending.findIndex(c => c?.id === id);
    if (slot < 0) return;
    this.finish(this.pending[slot]!, live);
    this.pending[slot] = null;
  }
  ingest(value: any, live: boolean) {
    const r = Codex.Rollout.decode(value),
      kind = r.type,
      p = r.payload,
      type = r.payloadType();
    if (kind === "turn_context" || (kind === "event_msg" && type === "task_started")) {
      this.bind(str(p, "turn_id"));
      return;
    }
    if (kind === "event_msg" && ["task_complete", "turn_complete", "turn_aborted"].includes(type ?? "")) {
      const turn = str(p, "turn_id");
      if (!turn || turn === this.turn.text()) this.ended = true;
      return;
    }
    if (kind !== "response_item" || !this.turn.len || this.ended) return;
    if (type === "message" && str(p, "role") === "assistant" && str(p, "phase") === "commentary") {
      const content = field(p, "content");
      if (Array.isArray(content)) {
        this.commentary = new Text(
          clip(
            "Latest agent update: " +
              content
                .filter(c => str(c, "type") === "output_text")
                .map(c => str(c, "text"))
                .join(""),
            2048,
          ),
        );
        this.dirty = true;
      }
      return;
    }
    const id = str(p, "call_id") || str(p, "id");
    if (!id) return;
    const key = this.key(id);
    if (this.seen.includes(key)) return;
    if (["function_call_output", "custom_tool_call_output"].includes(type ?? "")) {
      this.finishId(key, live);
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
      this.finish(call, live);
      return;
    }
    this.save(call, live);
  }
  ingestClaude(value: any, live: boolean) {
    if (!this.turn.len || this.ended) return;
    const line = Claude.Line.decode(value);
    if (!line) return;
    if (line.type === "system" && line.subtype === "turn_duration") {
      if (live) this.ended = true;
      return;
    }
    const content = field(line.message, "content");
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const type = str(block, "type");
      if (line.type === "assistant" && type === "text") {
        const text = str(block, "text").trim();
        if (!text) continue;
        this.commentary = new Text(clip("Latest agent update: " + text, 2048));
        this.dirty = true;
      } else if (line.type === "assistant" && type === "tool_use") {
        const id = str(block, "id");
        if (!id) continue;
        const key = this.key(id);
        if (this.seen.includes(key)) continue;
        const call = new Call();
        call.id = key;
        call.append(str(block, "name") + ": ");
        for (const name of ["description", "command", "file_path", "pattern", "query", "url", "prompt"]) {
          const detail = str(field(block, "input"), name);
          if (!detail) continue;
          call.detail(name === "file_path" ? shortPath(detail) : detail);
          break;
        }
        this.save(call, live);
      } else if (line.type === "user" && type === "tool_result") {
        const id = str(block, "tool_use_id");
        if (id) this.finishId(this.key(id), live);
      }
    }
  }
}
