//! Text measurement and clipping as the Zig viewer does it: Ghostty's width
//! per codepoint, byte lengths where Zig counts bytes. sidebar.zig keeps
//! these helpers; the TypeScript viewer shares them from here.
import { codepointWidths } from "./viewer_native";

/** An output buffer standing in for Zig's `*std.Io.Writer`. */
export class Writer {
  s = "";
  write(text: string): void {
    this.s += text;
  }
  splat(char: string, count: number): void {
    if (count > 0) this.s += char.repeat(count);
  }
  buffered(): string {
    return this.s;
  }
  clear(): void {
    this.s = "";
  }
}

export function codepointWidth(cp: number): number {
  return codepointWidths()[cp] ?? 1;
}
export function displayWidth(text: string): number {
  const table = codepointWidths();
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      width += table[c];
      continue;
    }
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++;
    width += table[cp];
  }
  return width;
}
/** UTF-8 length, which Zig's `len` is. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text);
}
/** The text cut to its first `bytes` UTF-8 bytes, as Zig's `text[0..bytes]`, keeping whole codepoints. */
export function byteSlice(text: string, bytes: number): string {
  if (bytes >= text.length * 3) return text;
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const size = utf8Size(ch.codePointAt(0)!);
    if (used + size > bytes) break;
    used += size;
    end += ch.length;
  }
  return text.slice(0, end);
}
export function utf8Size(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}
export function writeClipped(w: Writer, text: string, room: number): void {
  w.write(clipped(text, room));
}
export function clipped(text: string, room: number): string {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    used += codepointWidth(ch.codePointAt(0)!);
    if (used > room) break;
    end += ch.length;
  }
  return text.slice(0, end);
}
export function writeEllipsis(w: Writer, text: string, room: number): void {
  w.write(ellipsis(text, room));
}
export function ellipsis(text: string, room: number): string {
  if (displayWidth(text) <= room) return text;
  if (room <= 0) return "";
  return clipped(text, room - 1) + "…";
}
/** Keep the root and the longest whole-component suffix that fits. */
export function writeDirectory(w: Writer, path: string, room: number): void {
  if (displayWidth(path) <= room) return w.write(path);
  const prefix = path.startsWith("~/") ? "~/.../" : path.startsWith("/") ? "/.../" : ".../";
  if (room <= prefix.length) return writeClipped(w, path, room);
  let tail = path;
  for (;;) {
    const slash = tail.indexOf("/");
    if (slash < 0) break;
    tail = tail.slice(slash + 1);
    if (prefix.length + displayWidth(tail) <= room) {
      w.write(prefix);
      return w.write(tail);
    }
  }
  w.write(prefix);
  // A single oversized filename still keeps its end and complete codepoints.
  let width = displayWidth(tail);
  while (tail.length > 0 && width > room - prefix.length - 1) {
    const cp = tail.codePointAt(0)!;
    width -= codepointWidth(cp);
    tail = tail.slice(cp > 0xffff ? 2 : 1);
  }
  w.write("…");
  w.write(tail);
}
/**
 * A label safe to print: control characters become "?", and it is cut to
 * `cap` UTF-8 bytes, the size of the buffer Zig writes it into.
 */
export function directoryLabel(cwd: string, home: string | null = null, cap = 4097): string {
  let source = cwd.length === 0 ? "?" : cwd;
  let out = "";
  let len = 0;
  if (home !== null && home.length > 0 && source.startsWith(home) && (source.length === home.length || source[home.length] === "/")) {
    out = "~";
    len = 1;
    source = source.slice(home.length);
  }
  for (const ch of source) {
    if (len >= cap) break;
    const cp = ch.codePointAt(0)!;
    const valid = cp >= 32 && !(cp >= 127 && cp <= 159);
    const count = valid ? utf8Size(cp) : 1;
    if (len + count > cap) break;
    out += valid ? ch : "?";
    len += count;
  }
  return out;
}
export function compactCount(value: number | bigint): string {
  const v = BigInt(value);
  if (v < 1000n) return String(v);
  const scales: [bigint, string][] = [
    [1_000_000_000_000_000_000n, "E"],
    [1_000_000_000_000_000n, "P"],
    [1_000_000_000_000n, "T"],
    [1_000_000_000n, "G"],
    [1_000_000n, "M"],
    [1_000n, "k"],
  ];
  for (const [scale, suffix] of scales) if (v >= scale) return `${v / scale}${suffix}`;
  return String(v);
}
/** Zig's saturating subtraction for unsigned values. */
export function sat(a: number, b: number): number {
  return a > b ? a - b : 0;
}
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
/** Zig's @round: halves away from zero. */
export function zigRound(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
/** BoundedText.initTruncated: the longest prefix of `value` that fits `cap` bytes, at a UTF-8 boundary. */
export function truncatedText(value: string, cap: number): string {
  return byteSlice(value, cap);
}
/** BoundedText.ascii: printable ASCII, every other byte a space, cut to `cap` bytes. */
export function asciiText(value: string, cap: number): string {
  const bytes = Buffer.from(value).subarray(0, cap);
  return Array.from(bytes, (ch) => (ch >= 32 && ch < 127 ? String.fromCharCode(ch) : " ")).join("");
}
