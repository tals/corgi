import type { Terminal } from "./terminal";
import type { Wire } from "../protocol";
export interface Image {
  id: string;
  width: number;
  height: number;
  format: number;
  bytes: number;
}
export interface ImagePlacement {
  image: Image;
  x: number;
  y: number;
  width: number;
  height: number;
  source_x: number;
  source_y: number;
  source_width: number;
  source_height: number;
  z: number;
}
export interface Surface {
  pane: number;
  cols: number;
  rows: number;
  lines: string[];
  cursor: { x: number; y: number } | null;
  images?: ImagePlacement[];
}
export interface Modes {
  bracketed_paste: boolean;
  cursor_keys: boolean;
  keypad_keys: boolean;
  backarrow: boolean;
  numlock: boolean;
  alt_escape: boolean;
  modify_other: boolean;
  kitty: number;
  mouse_event: string;
  mouse_format: string;
  paste_events: boolean;
}
export interface Stamp {
  identity: bigint;
  revision: bigint;
  offset: number | null;
}
export interface View {
  input_ack?: InputReceipt;
  surface: Surface;
  bottom: number;
  offset: number;
  modes: Modes;
  stamp: Stamp;
}
export interface InputReceipt {
  epoch: string;
  sequence: bigint;
}
export function inputReceipt(value: Wire<InputReceipt> | InputReceipt): InputReceipt {
  return { epoch: value.epoch, sequence: BigInt(value.sequence) };
}
/** Changed rows relative to the preceding frame on an ordered stream. */
export interface Patch extends Omit<View, "surface"> {
  base: Stamp;
  surface: Omit<Surface, "lines"> & { lines: { row: number; line: string }[] };
}
export function difference(before: View, after: View): Patch | null {
  const a = before.surface,
    b = after.surface;
  if (before.stamp.identity !== after.stamp.identity || a.cols !== b.cols || a.rows !== b.rows) return null;
  const lines = b.lines.flatMap((line, row) => (line === a.lines[row] ? [] : [{ row, line }]));
  return { ...after, base: before.stamp, surface: { ...b, lines } };
}
export function apply(before: View | undefined, patch: Wire<Patch>): View {
  if (
    !before ||
    before.surface.pane !== patch.surface.pane ||
    before.surface.cols !== patch.surface.cols ||
    before.surface.rows !== patch.surface.rows ||
    before.stamp.identity !== BigInt(patch.base.identity) ||
    before.stamp.revision !== BigInt(patch.base.revision) ||
    before.stamp.offset !== patch.base.offset
  )
    throw Error("InvalidSurfaceBase");
  const lines = [...before.surface.lines];
  const changed = new Set<number>();
  for (const { row, line } of patch.surface.lines) {
    if (!Number.isInteger(row) || row < 0 || row >= lines.length || changed.has(row) || typeof line !== "string")
      throw Error("InvalidSurfaceRow");
    changed.add(row);
    lines[row] = line;
  }
  const { base: _, ...next } = patch;
  return view({ ...next, surface: { ...patch.surface, lines } });
}
export function captureView(id: number, t: Terminal, offset: number | null = null): View {
  return t.surface(id, offset);
}
export function capture(id: number, t: Terminal): Surface {
  return captureView(id, t).surface;
}
export function modes(t: Terminal): Modes {
  return t.native({ op: "info" }).modes;
}
export function stamp(t: Terminal, offset: number | null = null): Stamp {
  return { identity: t.surface_identity, revision: t.surface_revision, offset };
}

type NativeView = Omit<View, "stamp"> & {
  stamp: { identity: string; revision: string; offset: number | null };
};

export function view(value: Wire<View> | NativeView): View {
  return {
    ...value,
    input_ack: value.input_ack ? inputReceipt(value.input_ack) : undefined,
    stamp: {
      ...value.stamp,
      identity: BigInt(value.stamp.identity),
      revision: BigInt(value.stamp.revision),
    },
  };
}
