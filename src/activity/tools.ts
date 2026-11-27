import { injected } from "../providers/common";
import * as script_tools from "./script_tools";
import { Text } from "./summary";
import { BoundedText } from "../bounded_text";
class Turn extends BoundedText(160) {}
export type Outcome = "success" | "failure";
export type ToolRequest = { id: number; title: string };
export function readRequest(value: unknown): ToolRequest | null {
  if (value == null) return null;
  if (
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    shortLabel(value.title) !== value.title
  )
    throw Error("InvalidToolRequest");
  return { id: value.id, title: value.title };
}
export type Observation = {
  request?: ToolRequest | null;
  key: string;
  detail: string;
  description: string;
  running: boolean;
  outcome?: Outcome | null;
};
export class View {
  request: ToolRequest | null = null;
  calls: Observation[] = [];
  road_evidence = new Text();
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
/** One short line of provider prose, safe to write into a terminal. */
export function shortLabel(value: string) {
  const clean = Bun.stripANSI(value)
    .replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ")
    .trim();
  if (Buffer.byteLength(clean) <= 64) return clean;
  const head = clip(clean, 61);
  return (head.replace(/\s+\S*$/, "") || head) + "…";
}
export class Call {
  request: ToolRequest | null = null;
  description = "";
  describe(value: string) {
    this.description = shortLabel(value);
  }
  outcome: "success" | "failure" | null = null;
  result = "";
  id = 0n;
  live = false;
  value = "";
  static restore(saved: any) {
    if (saved === null) return null;
    if (typeof saved.value !== "string" || Buffer.byteLength(saved.value) > 240) throw Error("InvalidCheckpoint");
    const call = Object.assign(new Call(), { id: BigInt(saved.id), live: saved.live === true, value: saved.value });
    call.request = readRequest(saved.request);
    if (typeof saved.description === "string") call.describe(saved.description);
    return call;
  }
  /** A finished call with what it reported; older handoffs carry none. */
  static restoreOutcome(saved: any) {
    const call = Call.restore(saved);
    if (
      !call ||
      ![null, "success", "failure"].includes(saved.outcome ?? null) ||
      typeof (saved.result ?? "") !== "string" ||
      Buffer.byteLength(saved.result ?? "") > 320
    )
      throw Error("InvalidCheckpoint");
    return Object.assign(call, { outcome: saved.outcome ?? null, result: saved.result ?? "" });
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
  script(code: string) {
    const start = Buffer.byteLength(this.value);
    const calls = script_tools.read(code);
    if (!this.description && calls.length === 1 && calls[0].description) this.describe(calls[0].description);
    for (const [i, call] of calls.entries()) {
      if (Buffer.byteLength(this.value) >= start + 120) {
        this.bound(start, true);
        return true;
      }
      if (i) this.append("; ");
      if (call.name === "apply_patch") {
        this.append("apply_patch ");
        this.patchFiles(call.args[0]);
      } else if (call.name === "exec_command" && call.args.length) {
        this.append(
          call.args.map(cmd => clip(cmd.split(/\r?\n/, 1)[0].trim(), call.args.length > 1 ? 54 : 128)).join("; "),
        );
      } else this.append(call.description || call.name);
    }
    this.bound(start, false);
    return calls.length > 0;
  }
}
export class Tracker {
  request: ToolRequest | null = null;
  prompt = new Text();
  /** This turn's requests, oldest first: the one that started it and those typed while the agent worked. */
  asked: { text: string; queued: boolean }[] = [];
  commentary = new Text();
  turn = new Turn();
  ended = false;
  completed = 0n;
  pending: Array<Call | null> = Array(64).fill(null);
  next_pending = 0;
  seen: bigint[] = [];
  recent: Array<Call | null> = [null, null, null];
  outcomes: Call[] = [];
  /** Includes repeated calls and fast calls that finish between two transcript polls. */
  finished: Call[] = [];
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
    t.request = readRequest(saved.request);
    t.commentary = Text.fromJSON(saved.commentary);
    t.turn = Turn.fromJSON(saved.turn);
    t.ended = saved.ended === true;
    t.completed = BigInt(saved.completed);
    t.pending = saved.pending.map(Call.restore);
    t.next_pending = saved.next_pending;
    t.seen = saved.seen.map(BigInt);
    t.recent = saved.recent.map(Call.restore);
    if (saved.finished !== undefined) {
      if (!Array.isArray(saved.finished) || saved.finished.length > 64) throw Error("InvalidCheckpoint");
      t.finished = saved.finished.map((item: unknown) => {
        const call = Call.restoreOutcome(item);
        if (!call) throw Error("InvalidCheckpoint");
        return call;
      });
    }
    if (saved.outcomes !== undefined) {
      if (!Array.isArray(saved.outcomes) || saved.outcomes.length > 4) throw Error("InvalidCheckpoint");
      t.outcomes = saved.outcomes.map(Call.restoreOutcome);
    }
    // Older handoffs carry no request text.
    if (saved.prompt !== undefined) t.prompt = Text.fromJSON(saved.prompt);
    if (Array.isArray(saved.asked))
      t.asked = saved.asked
        .filter((m: any) => typeof m?.text === "string")
        .slice(-4)
        .map((m: any) => ({ text: clip(m.text, 300), queued: m.queued === true }));
    if (saved.request === undefined) {
      const text = t.asked.findLast(m => m.text.trim() && !injected(m.text))?.text ?? t.prompt.text();
      if (text.trim() && !injected(text)) t.request = { id: 1, title: shortLabel(text) };
    }
    t.dirty = saved.dirty === true;
    return t;
  }
  /** A person's message in this turn; `queued` when it arrived while the agent was working. */
  ask(text: string, queued: boolean) {
    if (text.trim() && !injected(text)) this.request = { id: (this.request?.id ?? 0) + 1, title: shortLabel(text) };
    this.prompt = new Text(clip(text, 512));
    this.asked = [...this.asked, { text: clip(text.replace(/\s+/g, " "), 300), queued }].slice(-4);
    this.dirty = true;
  }
  /** The request heading: one message as before, several as a list so a waiting one stays visible. */
  requests() {
    if (this.asked.length < 2) return this.prompt.len ? "User request: " + this.prompt.text() + "\n" : "";
    return (
      "User requests this turn (oldest to newest):\n" +
      this.asked.map((m, i) => `${i + 1}. ${m.text}${m.queued ? " [sent while the agent was working]" : ""}\n`).join("")
    );
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
    out.request = this.request;
    out.completed = this.completed;
    out.commentary = this.commentary;
    out.ended = this.ended;
    const observe = (call: Call, running: boolean) => {
      out.calls.push({
        key: call.id.toString(16),
        detail: call.text(),
        description: call.description,
        running,
        outcome: call.outcome,
        ...(call.request ? { request: call.request } : {}),
      });
    };
    for (const call of this.finished) observe(call, false);
    for (const call of this.pending) if (call?.live) observe(call, !this.ended);
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
    const outcomes = this.outcomes
      .map(call => {
        const result =
          Buffer.byteLength(call.result) <= 160
            ? call.result
            : clip(call.result, 80) + " … " + clip(call.result.slice(-80), 80);
        return `${clip(call.text(), 128)} [${call.outcome ?? "outcome unknown"}]: ${result}`;
      })
      .join("\n");
    out.road_evidence = new Text(
      clip(this.requests() + (outcomes ? "Recent tool outcomes (oldest to newest):\n" + outcomes : ""), 2048),
    );
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
    call.request = old?.id === call.id ? old.request : this.request;
    call.live = live || (old?.id === call.id && old.live) || false;
    if (old?.id === call.id && !call.description) call.description = old.description;
    if (
      (!old || old.text() !== call.text() || old.description !== call.description || old.live !== call.live) &&
      call.live
    )
      this.dirty = true;
    this.pending[slot] = call;
  }
  finish(call: Call, live: boolean) {
    if (this.seen.length === 256) this.seen.shift();
    this.seen.push(call.id);
    if (!live) return;
    this.finished.push(call);
    if (this.finished.length > 64) this.finished.shift();
    this.completed++;
    this.dirty = true;
    // Repeating a command must not erase the failure that preceded its successful retry.
    if (call.outcome || call.result) {
      this.outcomes.push(call);
      if (this.outcomes.length > 4) this.outcomes.shift();
    }
    if (this.recent[2]?.text() !== call.text()) {
      this.recent[0] = this.recent[1];
      this.recent[1] = this.recent[2];
    }
    this.recent[2] = call;
  }
  finishId(id: bigint, live: boolean, outcome: "success" | "failure" | null = null, result = "") {
    const slot = this.pending.findIndex(c => c?.id === id);
    if (slot < 0) return;
    this.pending[slot]!.outcome = outcome;
    this.pending[slot]!.result = clip(result.replace(/[\x00-\x1f\x7f-\x9f]/g, " "), 320);
    this.finish(this.pending[slot]!, live);
    this.pending[slot] = null;
  }
}
