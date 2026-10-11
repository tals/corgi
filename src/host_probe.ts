import { Theme } from "./theme";
import * as corgi_badge from "./corgi_badge";
import * as host_clipboard from "./host_clipboard";
import * as frame_pacing from "./frame_pacing";
const clipboard_prefix = "\x1b]5522;",
  mode_prefix = "\x1b[?5522;",
  version_prefix = "\x1bP>|",
  /** Mode 2031's report that the terminal switched between light and dark. */
  scheme_prefix = "\x1b[?997;",
  max_packet = 16 * 1024;
const paste_start = "\x1b[200~",
  paste_end = "\x1b[201~";
/** Byte strings preserve UTF-8 across arbitrary read boundaries. */
export class Probe {
  theme = new Theme();
  badge = new corgi_badge.State();
  clipboard = new host_clipboard.State();
  pacer = new frame_pacing.Pacer();
  changed = false;
  /** The terminal reported a new color scheme; its colors need asking again. */
  scheme_changed = false;
  paste = false;
  pending = "";
  touched = 0;
  packet = "";
  in_packet = false;
  packet_escape = false;
  feed(bytes: Uint8Array | string, now = Date.now()): Buffer {
    const input = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes),
      out: number[] = [];
    for (const byte of input) {
      if (this.in_packet) {
        this.touched = now;
        if (this.packet_escape) {
          this.packet_escape = false;
          if (byte === 92) {
            this.finishPacket(now);
            continue;
          }
          this.in_packet = false;
          this.pending = "\x1b";
        } else {
          if (byte === 7) this.finishPacket(now);
          else if (byte === 27) this.packet_escape = true;
          else if (this.packet.length <= max_packet) this.packet += String.fromCharCode(byte);
          continue;
        }
      }
      this.scan(byte, out, now);
    }
    return Buffer.from(out);
  }
  private scan(byte: number, out: number[], now: number) {
    if (!this.pending && byte !== 27) {
      out.push(byte);
      return;
    }
    const sequence = (this.pending += String.fromCharCode(byte));
    this.touched = now;
    if (sequence === paste_start || sequence === paste_end) {
      this.paste = sequence === paste_start;
      this.flush(out);
      return;
    }
    if (paste_start.startsWith(sequence) || paste_end.startsWith(sequence)) return;
    if (!this.paste) {
      if (corgi_badge.reply_prefix.startsWith(sequence)) return;
      if (sequence.startsWith(corgi_badge.reply_prefix)) {
        if (sequence.endsWith("\x1b\\")) {
          this.badge.accept(sequence);
          this.pending = "";
          return;
        }
        if (sequence.length < 128) return;
      }
      if (sequence === clipboard_prefix) {
        this.pending = "";
        this.in_packet = true;
        this.packet = "";
        return;
      }
      if (sequence.startsWith(mode_prefix)) {
        if (byte === 121) {
          const digits = sequence.slice(mode_prefix.length).split("$", 1)[0],
            value = /^\d+$/.test(digits) ? Number(digits) : 0;
          this.clipboard.modeReport(value <= 255 ? value : 0, now);
          this.pending = "";
          return;
        }
        if (sequence.length < 16) return;
      }
      if (sequence.startsWith(scheme_prefix)) {
        if (byte === 110) {
          this.scheme_changed = true;
          this.pending = "";
          return;
        }
        if (sequence.length < 16) return;
      }
      if (sequence.startsWith(version_prefix)) {
        if (sequence.endsWith("\x1b\\")) {
          this.clipboard.terminalName(sequence.slice(version_prefix.length, -2));
          this.pending = "";
          return;
        }
        if (sequence.length < 128) return;
      }
      if (sequence === frame_pacing.answer) {
        this.pacer.answered();
        this.pending = "";
        return;
      }
      const prefixes = [
        "\x1b]10;",
        "\x1b]11;",
        "\x1b]4;",
        clipboard_prefix,
        mode_prefix,
        version_prefix,
        scheme_prefix,
        frame_pacing.answer,
      ];
      if (prefixes.some(prefix => prefix.startsWith(sequence))) return;
      if (prefixes.slice(0, 3).some(prefix => sequence.startsWith(prefix))) {
        const terminator = byte === 7 ? 1 : sequence.endsWith("\x1b\\") ? 2 : 0;
        if (terminator) {
          if (this.theme.accept(sequence.slice(2, -terminator))) {
            this.changed = true;
            this.pending = "";
            return;
          }
        } else if (sequence.length < 128) return;
      }
    }
    this.flush(out);
  }
  private finishPacket(now: number) {
    this.in_packet = false;
    if (this.packet.length <= max_packet) this.clipboard.packet(this.packet, now);
  }
  private flush(out: number[]) {
    for (let i = 0; i < this.pending.length; i++) out.push(this.pending.charCodeAt(i));
    this.pending = "";
  }
  expire(now = Date.now()): Buffer {
    const out: number[] = [];
    if (this.pending && now - this.touched >= 100) this.flush(out);
    if (this.in_packet && now - this.touched >= 10_000) {
      this.in_packet = false;
      this.packet_escape = false;
    }
    return Buffer.from(out);
  }
  query(): string {
    return "\x1b]10;?\x1b\\\x1b]11;?\x1b\\" + Array.from({ length: 16 }, (_, i) => `\x1b]4;${i};?\x1b\\`).join("");
  }
}
