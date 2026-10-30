//! The viewer's terminal-protocol mechanics behind the native boundary:
//! Corgi's own Zig with Ghostty, as the Zig viewer runs them. See
//! native/viewer_bridge.zig.
import * as telemetry from "./telemetry";
import type { Pointer } from "bun:ffi";
import { n, ptr } from "./native_ffi";
import type { Key, Mods } from "./keyboard";
import type { View } from "./pane/surface";

function take(size: number): Buffer {
  if (size < 0) throw Error("NativeViewerFailed");
  const out = Buffer.alloc(size);
  if (size > 0 && Number(n.viewer_take(ptr(out), size)) !== size) throw Error("NativeViewerFailed");
  return out;
}
const bytes = (text: string | Uint8Array) => (typeof text === "string" ? Buffer.from(text) : text);
// FFI pointers to an empty buffer are invalid; pass one spare byte.
const nonEmpty = (data: Uint8Array) => (data.length > 0 ? data : Buffer.alloc(1));

export function receive(handle: Pointer | bigint, view: string): void {
  const telemetry_started = telemetry.begin();
  try {
    const data = Buffer.from(view);
    const status = n.viewer_receive(handle as Pointer, ptr(nonEmpty(data)), data.length);
    if (status < 0) throw Error(status === -1 ? "InvalidSurface" : "OutOfMemory");
  } finally {
    telemetry.end("surface.receive", telemetry_started);
  }
}
const mouseEventsByName = new Map(["none", "x10", "normal", "button", "any"].map((name, id) => [name, id]));
const mouseFormatsByName = new Map(["x10", "utf8", "sgr", "urxvt", "sgr_pixels"].map((name, id) => [name, id]));
const u16 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 65535;
const spare_row = new Uint16Array(1);

/** Install already-decoded rows and scalar modes without a JSON round trip. */
export function receiveFrame(handle: Pointer | bigint, view: View, changed?: Uint16Array): void {
  const started = telemetry.begin();
  let transferred = 0;
  try {
    const { surface: frame, modes } = view;
    if (
      !u16(frame.cols) ||
      !u16(frame.rows) ||
      !Number.isInteger(modes.kitty) ||
      modes.kitty < 0 ||
      modes.kitty > 31 ||
      (frame.cursor && (!u16(frame.cursor.x) || !u16(frame.cursor.y)))
    )
      throw Error("InvalidSurface");
    let rows = "";
    if (changed) {
      for (const row of changed) {
        if (row >= frame.rows) throw Error("InvalidSurface");
        rows += `\x1b[0m\x1b[${row + 1};1H\x1b[2K${frame.lines[row] ?? ""}`;
      }
    } else {
      for (let row = 0; row < frame.lines.length; row++) rows += `\x1b[${row + 1};1H${frame.lines[row]}`;
    }
    rows += frame.cursor ? `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H\x1b[?25h` : "\x1b[?25l";
    const data = Buffer.from(rows);
    transferred = data.length;
    const flags =
      Number(modes.bracketed_paste) |
      (Number(modes.cursor_keys) << 1) |
      (Number(modes.keypad_keys) << 2) |
      (Number(modes.backarrow) << 3) |
      (Number(modes.numlock) << 4) |
      (Number(modes.alt_escape) << 5) |
      (Number(modes.modify_other) << 6) |
      (Number(modes.paste_events) << 7);
    const event = mouseEventsByName.get(modes.mouse_event),
      format = mouseFormatsByName.get(modes.mouse_format);
    if (event === undefined || format === undefined) throw Error("InvalidSurface");
    const status = n.viewer_receive_frame(
      handle as Pointer,
      ptr(data),
      data.length,
      frame.cols,
      frame.rows,
      flags,
      modes.kitty,
      event,
      format,
      changed === undefined,
      ptr(changed?.length ? changed : spare_row),
      changed?.length ?? 0,
    );
    if (status < 0) throw Error(status === -1 ? "InvalidSurface" : "OutOfMemory");
  } finally {
    telemetry.end("surface.receive", started, transferred);
  }
}
export function updateRender(handle: Pointer | bigint): void {
  if (n.viewer_update_render(handle as Pointer) < 0) throw Error("OutOfMemory");
}
/** The pane's rows inside a rectangle, each starting at its own position. */
export function rows(
  handle: Pointer | bigint,
  pane: number,
  x: number,
  y: number,
  w: number,
  h: number,
  dimmed: boolean,
  hovered: bigint | null,
): string {
  const size = Number(n.viewer_rows(handle as Pointer, pane, x, y, w, h, dimmed, hovered !== null, hovered ?? 0n));
  return take(size).toString();
}
/** The render state's cursor in the viewport; only a visible one when `visible`. */
export function cursor(handle: Pointer | bigint, visible = true): { x: number; y: number } | null {
  const packed = Number(n.viewer_cursor(handle as Pointer, visible));
  return packed < 0 ? null : { x: Math.floor(packed / 65536), y: packed % 65536 };
}
/** Whether the pane's program asked for mouse events. */
export function mouseEvents(handle: Pointer | bigint): boolean {
  return n.viewer_mouse_event(handle as Pointer) !== 0;
}
export function bracketedPaste(handle: Pointer | bigint): boolean {
  return n.viewer_mode(handle as Pointer, 0);
}
export function pasteEvents(handle: Pointer | bigint): boolean {
  return n.viewer_mode(handle as Pointer, 1);
}
function modBits(mods: Mods): number {
  return (
    (mods.shift ? 1 : 0) |
    (mods.alt ? 2 : 0) |
    (mods.ctrl ? 4 : 0) |
    (mods.super ? 8 : 0) |
    (mods.caps_lock ? 64 : 0) |
    (mods.num_lock ? 128 : 0)
  );
}
/** A key encoded for a pane's program, or with default options when `handle` is null. */
export function encodeKey(handle: Pointer | bigint | null, key: Key): string {
  return take(Number(n.viewer_encode_key((handle ?? null) as Pointer, key.codepoint, modBits(key.mods)))).toString();
}
export function encodeMouse(handle: Pointer | bigint, button: number, x: number, y: number, release: boolean): string {
  return take(Number(n.viewer_encode_mouse(handle as Pointer, button, x, y, release))).toString();
}
/** Ghostty's paste encoding: all parts, or one of its three. */
export function encodePaste(text: string | Uint8Array, bracketed: boolean, part = -1): Buffer {
  const data = bytes(text);
  return take(Number(n.viewer_paste(ptr(nonEmpty(data)), data.length, bracketed, part)));
}
export function isSafePaste(text: string | Uint8Array): boolean {
  const data = bytes(text);
  return n.viewer_paste_safe(ptr(nonEmpty(data)), data.length);
}
let widths: Uint8Array | null = null;
/** Ghostty's cell width for every codepoint. */
export function codepointWidths(): Uint8Array {
  if (widths) return widths;
  const table = new Uint8Array(0x110000);
  n.unicode_widths(ptr(table), table.length);
  widths = table;
  return table;
}
