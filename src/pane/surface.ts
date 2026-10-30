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
  surface: Surface;
  bottom: number;
  offset: number;
  modes: Modes;
  stamp: Stamp;
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
    stamp: {
      ...value.stamp,
      identity: BigInt(value.stamp.identity),
      revision: BigInt(value.stamp.revision),
    },
  };
}
