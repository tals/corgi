//! Frames one host's input stream. Consumers retain these boundaries through queues and awaits.
import * as hostClipboard from "./host_clipboard";
import * as keyboard from "./keyboard";
import * as keys from "./keys";

export interface Mouse {
  button: number;
  x: number;
  y: number;
  release: boolean;
}
export type Input =
  | { kind: "key"; bytes: Uint8Array; key: keyboard.Key }
  | { kind: "mouse"; bytes: Uint8Array; mouse: Mouse }
  | { kind: "text" | "sequence" | "paste_start" | "paste" | "paste_end"; bytes: Uint8Array };

const escape_ms = 50,
  sequence_ms = 1000,
  string_ms = 10_000,
  sequence_limit = 256,
  string_limit = 16 * 1024 + 16,
  chunk_size = 4096;
const paste_end = Array.from(Buffer.from(keys.paste_end)),
  clipboard = Array.from(Buffer.from(hostClipboard.packet_prefix));
type State = "ground" | "escape" | "csi" | "ss3" | "osc" | "dcs" | "apc" | "utf8" | "alt" | "paste";
const utf8Length = (byte: number) =>
  byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;

function sequence(bytes: Uint8Array): Input | null {
  const value = Buffer.from(bytes).toString("latin1"),
    mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(value);
  if (mouse) {
    if (!mouse.slice(1, 4).every(value => Number.isSafeInteger(Number(value)) && Number(value) <= 65535)) return null;
    return {
      kind: "mouse",
      bytes,
      mouse: {
        button: Number(mouse[1]),
        x: Math.max(0, Number(mouse[2]) - 1),
        y: Math.max(0, Number(mouse[3]) - 1),
        release: mouse[4] === "m",
      },
    };
  }
  let key = keyboard.decode(value);
  if (value === "\x1b") key = { codepoint: 27, mods: {} };
  else if (!key && bytes[0] === 27) {
    const text = keyboard.textKey(Array.from(bytes.subarray(1)));
    if (text.key && text.length === bytes.length - 1)
      key = { ...text.key, mods: { alt: true, shift: text.key.codepoint >= 65 && text.key.codepoint <= 90 } };
  }
  return key ? { kind: "key", bytes, key } : { kind: "sequence", bytes };
}

function emit(out: Input[], bytes: Uint8Array): void {
  const input = sequence(bytes);
  if (input) out.push(input);
}

export const pasting = (input: Input) =>
  input.kind === "paste_start" || input.kind === "paste" || input.kind === "paste_end";

/** Counts queued bytes without losing event boundaries across connection handoffs. */
export class Queue<T extends Input = Input> {
  private events: T[] = [];
  bytes = 0;
  push(input: T): void {
    this.events.push(input);
    this.bytes += input.bytes.length;
  }
  take(): T[] {
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    return events;
  }
}

export class Parser {
  private state: State = "ground";
  private pending: number[] = [];
  private touched = 0;
  private discard_until: number | null = null;
  private escaped = false;

  /** A monotonic deadline; a paste's delimiter never expires. */
  due(): number {
    if (this.discard_until !== null) return this.discard_until;
    if (this.state === "ground" || this.state === "paste") return Infinity;
    const ambiguous = this.pending.length <= 2 && this.state !== "utf8" && this.state !== "alt";
    return this.touched + (ambiguous ? escape_ms : this.slow() ? string_ms : sequence_ms);
  }
  expire(now = performance.now()): Input[] {
    const due = this.due();
    if (due === Infinity || now < due) return [];
    if (this.discard_until !== null) {
      this.reset();
      return [];
    }
    if (this.pending.length <= 2 && this.state !== "utf8" && this.state !== "alt") {
      const input = sequence(Uint8Array.from(this.pending));
      this.reset();
      return input ? [input] : [];
    }
    if (this.state === "utf8" || this.state === "alt") {
      const bytes = Uint8Array.from(this.pending),
        input: Input = this.state === "utf8" ? { kind: "text", bytes } : { kind: "sequence", bytes };
      this.reset();
      return [input];
    }
    // Briefly drain late tails, but a missing terminator cannot hold typing forever.
    this.pending = [];
    this.discard_until = due + sequence_ms;
    if (now >= this.discard_until) this.reset();
    return [];
  }
  feed(bytes: Uint8Array, now = performance.now()): Input[] {
    const out = this.expire(now);
    let data: number[] = [];
    const flush = () => {
      if (data.length) out.push({ kind: this.state === "paste" ? "paste" : "text", bytes: Uint8Array.from(data) });
      data = [];
    };
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      // Once identified, a control has a fixed lifetime even if bytes keep arriving.
      if (this.pending.length <= 2) this.touched = now;
      if (this.state === "paste") {
        if (byte !== paste_end[this.pending.length]) {
          data.push(...this.pending);
          this.pending = [];
        }
        if (byte === paste_end[this.pending.length]) {
          this.pending.push(byte);
          if (this.pending.length === paste_end.length) {
            flush();
            out.push({ kind: "paste_end", bytes: Uint8Array.from(this.pending) });
            this.reset();
          }
        } else data.push(byte);
        if (data.length >= chunk_size) flush();
        continue;
      }
      if (this.state === "ground") {
        if (byte === 27) {
          flush();
          this.pending = [byte];
          this.state = "escape";
        } else if (utf8Length(byte) > 1) {
          this.pending = [byte];
          this.state = "utf8";
        } else {
          if (byte < 32 || byte === 127) flush();
          data.push(byte);
          if (byte < 32 || byte === 127 || data.length >= chunk_size) flush();
        }
        continue;
      }
      if (this.state === "utf8" || this.state === "alt") {
        const offset = this.state === "alt" ? 1 : 0;
        if (byte < 0x80 || byte > 0xbf) {
          if (offset) out.push({ kind: "sequence", bytes: Uint8Array.from(this.pending) });
          else data.push(...this.pending);
          this.reset();
          i--;
          continue;
        }
        this.pending.push(byte);
        if (this.pending.length - offset === utf8Length(this.pending[offset])) {
          if (offset) emit(out, Uint8Array.from(this.pending));
          else data.push(...this.pending);
          this.reset();
          if (data.length >= chunk_size) flush();
        }
        continue;
      }
      if (this.string()) {
        if (this.pending.length === 2 && byte === 27) {
          emit(out, Uint8Array.from(this.pending));
          this.reset();
          this.pending = [27];
          this.state = "escape";
          continue;
        }
        if (this.escaped) {
          if (byte === 92) {
            this.append(byte, now);
            this.finish(out);
            continue;
          }
          this.reset();
          this.pending = [27];
          this.state = "escape";
          i--;
          continue;
        }
        // Host reply prefixes distinguish strings from legacy Alt chords and text.
        if (
          this.pending.length === 2 &&
          ((this.state === "osc" && (byte < 48 || byte > 57)) ||
            (this.state === "dcs" && (byte < 0x20 || byte > 0x3f)) ||
            (this.state === "apc" && byte !== 71))
        ) {
          emit(out, Uint8Array.from(this.pending));
          this.reset();
          i--;
          continue;
        }
        this.append(byte, now);
        if (byte === 27) this.escaped = true;
        else if (byte === 7 && this.state === "osc") this.finish(out);
        continue;
      }
      if (byte === 27) {
        // An interrupted introducer is still a legacy key; longer fragments are controls.
        if (this.pending.length <= 2 && this.discard_until === null) emit(out, Uint8Array.from(this.pending));
        this.reset();
        this.pending = [27];
        this.state = "escape";
        this.touched = now;
        continue;
      }
      if (this.state !== "escape" && (byte < 0x20 || byte > 0x7e)) {
        if (this.pending.length <= 2 && this.discard_until === null) emit(out, Uint8Array.from(this.pending));
        this.reset();
        i--;
        continue;
      }
      this.append(byte, now);
      if (this.state === "escape") {
        switch (byte) {
          case 91:
            this.state = "csi";
            break;
          case 79:
            this.state = "ss3";
            break;
          case 93:
            this.state = "osc";
            break;
          case 80:
            this.state = "dcs";
            break;
          case 95:
            this.state = "apc";
            break;
          default:
            if (utf8Length(byte) > 1) this.state = "alt";
            else this.finish(out);
        }
      } else if (byte >= 0x40 && byte <= 0x7e) this.finish(out);
    }
    flush();
    return out;
  }
  /** A clipboard packet can take a slow link seconds; every other reply is short. */
  private slow(): boolean {
    return this.state === "osc" && clipboard.every((byte, at) => this.pending[at] === byte);
  }
  private string(): boolean {
    return this.state === "osc" || this.state === "dcs" || this.state === "apc";
  }
  private append(byte: number, now: number): void {
    if (this.discard_until !== null) return;
    this.pending.push(byte);
    if (this.pending.length > (this.string() ? string_limit : sequence_limit)) {
      this.pending = [];
      this.discard_until = now + sequence_ms;
    }
  }
  private finish(out: Input[]): void {
    if (this.discard_until === null) {
      const bytes = Uint8Array.from(this.pending);
      if (Buffer.from(bytes).toString("latin1") === keys.paste_start) {
        this.reset();
        this.state = "paste";
        out.push({ kind: "paste_start", bytes });
        return;
      }
      if (Buffer.from(bytes).toString("latin1") === keys.paste_end) out.push({ kind: "paste_end", bytes });
      else emit(out, bytes);
    }
    this.reset();
  }
  private reset(): void {
    this.state = "ground";
    this.pending = [];
    this.discard_until = null;
    this.escaped = false;
  }
}
