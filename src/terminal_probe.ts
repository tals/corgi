//! What the viewer asks its terminal once it starts, for bug reports: which
//! modes it keeps, its keyboard protocol, its window in pixels, how wide it
//! draws characters terminals disagree on and, where it says, its font.
//! Replies arrive among typed input; `Collector` takes them only while its
//! questions are out, and the device attributes, asked last, say every
//! answer is in.
import { displayWidth } from "./text";

/** Characters terminals draw at different widths, by what they are. A
 * sequence is joined or not by the terminal; Corgi measures code points, so
 * it has no width to hold one to, and the report only says what was drawn. */
export const width_samples: { kind: string; text: string; sequence: boolean }[] = [
  { kind: "emoji", text: "👍", sequence: false },
  { kind: "text symbol", text: "⚠", sequence: false },
  { kind: "emoji presentation", text: "⚠️", sequence: true },
  { kind: "flag", text: "🇺🇸", sequence: true },
  { kind: "joined emoji", text: "👨‍👩‍👧", sequence: true },
  { kind: "combining accent", text: "e\u0301", sequence: false },
  { kind: "ambiguous width", text: "±", sequence: false },
  { kind: "corgi face", text: "ᴥ", sequence: false },
];
/** Synchronized output, grapheme clusters, focus events, SGR mouse,
 * bracketed paste and color scheme reports. */
export const modes = [2026, 2027, 1004, 1006, 2004, 2031] as const;
/** XTGETTCAP names: Kitty's font queries and the styled underline. */
const caps = ["kitty-query-font_family", "kitty-query-font_size", "Smulx"] as const;
/** How long a terminal that never answers the device attributes holds input. */
const wait_ms = 5000;
/** How long answers that come after it gave up are still taken, and dropped,
 * so a slow link's late replies don't reach a pane as typed input. */
const late_ms = 10_000;
/** The answers the probe asks for, as `accept` reads them; late, any of
 * them is dropped. */
const answer_shapes = [
  /^\x1b\[\?[\d;]*c$/,
  /^\x1b\[>[\d;]*c$/,
  /^\x1b\[\?\d+;\d+\$y$/,
  /^\x1b\[\?\d+u$/,
  /^\x1b\[[46];\d+;\d+t$/,
  /^\x1bP[01]\+r[0-9a-fA-F=]*\x1b\\$/,
];

export interface Width {
  /** What the sample is, as the report names it. */
  kind: string;
  text: string;
  /** As Corgi lays it out; null for a sequence, which it doesn't measure whole. */
  expected: number | null;
  /** As the terminal drew it; null when it didn't say. */
  got: number | null;
}
/** What the terminal answered. */
export interface Answers {
  /** It answered the device attributes, so it saw every question. */
  answered: boolean;
  da1: number[];
  da2: string;
  /** DECRQM's answer for each mode: 1 set, 2 reset, 0 unknown. */
  modes: Record<string, number>;
  /** Kitty keyboard protocol flags; null without the protocol. */
  keyboard: number | null;
  window: { width: number; height: number } | null;
  /** A cell in pixels, as the terminal reports it. */
  cell: { width: number; height: number } | null;
  font: string;
  undercurl: boolean;
  widths: Width[];
  /** Each reply as it came, escapes spelled out. */
  replies: string[];
}
const hex = (text: string) => Buffer.from(text).toString("hex");
const unhex = (text: string) => (/^([0-9a-f]{2})*$/i.test(text) ? Buffer.from(text, "hex").toString() : "");
/** A reply with its escapes spelled out, for the full report. */
export function spelled(sequence: string): string {
  return sequence.replace(/\x1b/g, "\\e").replace(/[\x00-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16)}`);
}

export class Collector {
  /** Questions are out; until then it takes nothing. */
  armed = false;
  done = false;
  private deadline = 0;
  private rows = 0;
  private next = 0;
  private caps: Record<string, string> = {};
  answers: Answers = {
    answered: false,
    da1: [],
    da2: "",
    modes: {},
    keyboard: null,
    window: null,
    cell: null,
    font: "",
    undercurl: false,
    widths: [],
    replies: [],
  };
  /** The questions, for a terminal `rows` tall. Each sample is drawn on the
   * bottom row and the cursor's column asked; the row is cleared after.
   * Without `rows`, as in a shell, they're drawn on the cursor's line. */
  start(rows: number | null, now: number): string {
    this.armed = true;
    this.done = false;
    this.deadline = now + wait_ms;
    this.rows = rows ?? 0;
    this.next = 0;
    this.answers.widths = width_samples.map(({ kind, text, sequence }) => ({
      kind,
      text,
      expected: sequence ? null : displayWidth(text),
      got: null,
    }));
    const at = rows === null ? "\r" : `\x1b[${rows};1H`;
    return (
      "\x1b7" +
      width_samples.map(({ text }) => `${at}${text}\x1b[6n`).join("") +
      `${at}\x1b[2K\x1b8` +
      modes.map(mode => `\x1b[?${mode}$p`).join("") +
      "\x1b[?u\x1b[14t\x1b[16t" +
      caps.map(cap => `\x1bP+q${hex(cap)}\x1b\\`).join("") +
      "\x1b[c"
    );
  }
  /** Whether `sequence`, an escape sequence typed input may hold, could
   * still grow into an answer. */
  wants(sequence: string): boolean {
    if (!this.armed && !this.late()) return false;
    if (sequence.startsWith("\x1bP")) return !sequence.endsWith("\x1b\\") && sequence.length < 512;
    return sequence.startsWith("\x1b[") && sequence.length < 64 && !/[@-~]$/.test(sequence.slice(2));
  }
  /** Takes an answer to one of its questions; false leaves `sequence` to typed input. */
  accept(sequence: string): boolean {
    if (!this.armed) return this.late() && this.dropLate(sequence);
    const a = this.answers;
    let m: RegExpExecArray | null;
    if ((m = /^\x1b\[\?([\d;]*)c$/.exec(sequence))) {
      a.da1 = m[1].split(";").filter(Boolean).map(Number);
      a.answered = true;
      this.finish();
    } else if ((m = /^\x1b\[>([\d;]*)c$/.exec(sequence))) a.da2 = m[1];
    else if ((m = /^\x1b\[\?(\d+);(\d+)\$y$/.exec(sequence))) a.modes[m[1]] = Number(m[2]);
    else if ((m = /^\x1b\[\?(\d+)u$/.exec(sequence))) a.keyboard = Number(m[1]);
    else if ((m = /^\x1b\[4;(\d+);(\d+)t$/.exec(sequence))) a.window = { width: Number(m[2]), height: Number(m[1]) };
    else if ((m = /^\x1b\[6;(\d+);(\d+)t$/.exec(sequence))) a.cell = { width: Number(m[2]), height: Number(m[1]) };
    // A modified F3 also reads as a position, but on the top row. On the
    // cursor's line, any row will do: a shell isn't reading keys meanwhile.
    else if (
      (m = /^\x1b\[(\d+);(\d+)R$/.exec(sequence)) &&
      (this.rows === 0 || Number(m[1]) === this.rows) &&
      this.next < a.widths.length
    )
      a.widths[this.next++].got = Number(m[2]) - 1;
    else if ((m = /^\x1bP([01])\+r([0-9a-fA-F]*)(?:=([0-9a-fA-F]*))?\x1b\\$/.exec(sequence))) {
      if (m[1] === "1") this.caps[unhex(m[2])] = unhex(m[3] ?? "");
    } else return false;
    a.replies.push(spelled(sequence));
    return true;
  }
  /** Stops waiting for a terminal that never answered. */
  expire(now: number): void {
    if (!this.armed || now < this.deadline) return;
    this.late_until = now + late_ms;
    this.finish();
  }
  private late_until = 0;
  private late(): boolean {
    return Date.now() < this.late_until;
  }
  /** Drops an answer that came after the probe gave up; the device
   * attributes, asked last, end the wait. */
  private dropLate(sequence: string): boolean {
    const position = /^\x1b\[(\d+);\d+R$/.exec(sequence);
    if (position) return this.rows > 0 && Number(position[1]) === this.rows;
    if (!answer_shapes.some(shape => shape.test(sequence))) return false;
    if (/^\x1b\[\?[\d;]*c$/.test(sequence)) this.late_until = 0;
    return true;
  }
  private finish() {
    this.armed = false;
    this.done = true;
    const family = this.caps["kitty-query-font_family"],
      size = this.caps["kitty-query-font_size"];
    this.answers.font = family ? `${family}${size ? ` ${size}pt` : ""}` : "";
    this.answers.undercurl = "Smulx" in this.caps;
  }
}
