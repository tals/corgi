import type { Key as LogicalKey } from "./keyboard";
export const paste_start = "\x1b[200~",
  paste_end = "\x1b[201~";
const map: Record<string, string> = {
  "\u001b[A": "up",
  "\u001bOA": "up",
  "\u001b[B": "down",
  "\u001bOB": "down",
  "\u001b[C": "right",
  "\u001bOC": "right",
  "\u001b[D": "left",
  "\u001bOD": "left",
  "\u001b[5~": "page_up",
  "\u001b[6~": "page_down",
  "\u001b[H": "home",
  "\u001bOH": "home",
  "\u001b[1~": "home",
  "\u001b[F": "end",
  "\u001bOF": "end",
  "\u001b[4~": "end",
  "\u001b[3~": "delete",
  "\u001b[Z": "shift_tab",
  "\u001b[I": "focus_in",
  "\u001b[O": "focus_out",
  "\u001b[200~": "paste_start",
  "\u001b[201~": "paste_end",
};
export type Key =
  | "delete"
  | "down"
  | "end"
  | "focus_in"
  | "focus_out"
  | "home"
  | "left"
  | "page_down"
  | "page_up"
  | "paste_end"
  | "paste_start"
  | "right"
  | "shift_tab"
  | "up";
export function parse(seq: string): Key | null {
  return (map[seq] as Key) ?? null;
}
const named: Record<string, number> = {
  esc: 27,
  enter: 13,
  tab: 9,
  backspace: 127,
  left: 57350,
  right: 57351,
  up: 57352,
  down: 57353,
  home: 57356,
  end: 57357,
  delete: 57349,
  pageup: 57354,
  pagedown: 57355,
  space: 32,
};
export function logicalKey(name: string): LogicalKey {
  const parts = name.split("+");
  const key = parts.pop()!;
  const mods: Record<string, boolean> = {};
  for (const mod of parts) {
    if (!["ctrl", "alt", "shift"].includes(mod)) throw new Error("InvalidKey");
    mods[mod] = true;
  }
  const codepoint =
    named[key] ??
    (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127
      ? key.charCodeAt(0)
      : null);
  if (codepoint === null) throw new Error("InvalidKey");
  return { codepoint, mods };
}
