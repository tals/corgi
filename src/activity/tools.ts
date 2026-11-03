import { Text } from "./summary";
import { BoundedText } from "../bounded_text";
class Turn extends BoundedText(160) {}
export class View {
  commentary = new Text();
  running = 0;
  ended = false;
  turn = new Turn();
  completed = 0n;
  evidence = new Text();
}
export function clip(value: string, limit: number) {
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
  static restore(saved: any) {
    if (saved === null) return null;
    if (typeof saved.value !== "string" || Buffer.byteLength(saved.value) > 240) throw Error("InvalidCheckpoint");
    return Object.assign(new Call(), { id: BigInt(saved.id), live: saved.live === true, value: saved.value });
  }
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
  /** The tracker a handoff carried, or a new one. */
  static restore(saved: any) {
    const t = new Tracker();
    if (!saved) return t;
    if (
      !Array.isArray(saved.pending) ||
      saved.pending.length !== 64 ||
      !Number.isInteger(saved.next_pending) ||
      saved.next_pending < 0 ||
      saved.next_pending >= 64 ||
      !Array.isArray(saved.seen) ||
      saved.seen.length > 256 ||
      !Array.isArray(saved.recent) ||
      saved.recent.length !== 3
    )
      throw Error("InvalidCheckpoint");
    t.commentary = Text.fromJSON(saved.commentary);
    t.turn = Turn.fromJSON(saved.turn);
    t.ended = saved.ended === true;
    t.completed = BigInt(saved.completed);
    t.pending = saved.pending.map(Call.restore);
    t.next_pending = saved.next_pending;
    t.seen = saved.seen.map(BigInt);
    t.recent = saved.recent.map(Call.restore);
    t.dirty = saved.dirty === true;
    return t;
  }
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
}
