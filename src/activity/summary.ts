import { field, str } from "../providers/common";
import { BoundedText } from "../bounded_text";
import type { Action } from "./prompt";
export class Text extends BoundedText(2048) {}
export class Label extends BoundedText(80) {}
export const hash = (text: Text) => Bun.hash.wyhash(text.text(), 0n);
export const turnTag = (turn: string) =>
  Number(BigInt.asUintN(32, Bun.hash.wyhash(turn, 0n)))
    .toString(16)
    .padStart(8, "0");
export function validateLabel(value: string) {
  const clean = value.replace(/^[ \t\r\n"]+|[ \t\r\n"]+$/g, "");
  if (!clean) throw Error("EmptyLabel");
  if (clean.includes("\ufffd")) throw Error("InvalidUtf8");
  const count = clean.split(" ").filter(Boolean).length;
  if (count < 2 || count > 6) throw Error("InvalidWordCount");
  if (/[\x00-\x1f\x7f-\x9f]/.test(clean)) throw Error("ControlCharacter");
  if (Buffer.byteLength(clean) > 80) throw Error("LabelTooLong");
  return new Label(clean);
}
export function parseLabel(value: string) {
  try {
    return validateLabel(value);
  } catch {
    return null;
  }
}
export class Conversation {
  recent: Text[] = Array.from({ length: 4 }, () => new Text());
  len = 0;
  previous = new Text();
  /** The phases of the turn tagged `phase_turn`, oldest first; the last is the current one. */
  phases: Label[] = Array.from({ length: 4 }, () => new Label());
  phases_len = 0;
  phase_turn = new Label();
  key(actor: number) {
    return `activity:${actor}`;
  }
  phase(turn: string) {
    if (this.phase_turn.text() !== turnTag(turn) || !this.phases_len) return null;
    return this.phases[this.phases_len - 1].text();
  }
  earlier(turn: string) {
    if (this.phase_turn.text() !== turnTag(turn)) return [];
    return this.phases.slice(0, Math.max(0, this.phases_len - 1)).map(phase => phase.text());
  }
  remember(turn: string, evidence: string, label: Text, action: Action = "new") {
    if (this.len === 4) {
      this.recent.shift();
      this.recent.push(new Text());
      this.len--;
    }
    this.recent[this.len++] = new Text(
      `Turn: ${turnTag(turn)}\nActivity: ${label.text()}\nEvidence: ${evidence.slice(0, 512)}`.slice(0, 2048),
    );
    this.previous = label;
    if (this.phase_turn.text() !== turnTag(turn)) {
      this.phase_turn = new Label(turnTag(turn));
      this.phases_len = 0;
    }
    const phase = new Label(label.text());
    if (action === "amend" && this.phases_len) this.phases[this.phases_len - 1] = phase;
    else if (this.phase(turn) !== phase.text()) {
      if (this.phases_len === 4) {
        this.phases.shift();
        this.phases.push(new Label());
        this.phases_len--;
      }
      this.phases[this.phases_len++] = phase;
    }
  }
}
export function codex(turn: any) {
  const items = field(turn, "items");
  if (!Array.isArray(items)) return new Text();
  let latest = "",
    out = "";
  for (const item of items) if (str(item, "type") === "agentMessage") latest = str(item, "text");
  if (latest) out = `Latest agent update: ${latest.slice(0, 1400)}\n`;
  for (const item of items) {
    if (str(item, "type") !== "userMessage" || !Array.isArray(field(item, "content"))) continue;
    out += "User request: ";
    for (const part of field(item, "content")) if (str(part, "type") === "text") out += str(part, "text");
    break;
  }
  return new Text(out.slice(0, 2048));
}
