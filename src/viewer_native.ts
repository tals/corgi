//! The viewer's terminal-protocol mechanics behind the native boundary:
//! Corgi's own Zig with Ghostty, as the Zig viewer runs them. See
//! native/viewer_bridge.zig.
import type { Pointer } from "bun:ffi";
import { n, ptr } from "./native_ffi";

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
  const data = Buffer.from(view);
  const status = n.viewer_receive(handle as Pointer, ptr(nonEmpty(data)), data.length);
  if (status < 0) throw Error(status === -1 ? "InvalidSurface" : "OutOfMemory");
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
export interface Mods {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  super?: boolean;
  caps_lock?: boolean;
  num_lock?: boolean;
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
export function encodeKey(handle: Pointer | bigint | null, codepoint: number, mods: Mods): string {
  return take(Number(n.viewer_encode_key((handle ?? null) as Pointer, codepoint, modBits(mods)))).toString();
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
