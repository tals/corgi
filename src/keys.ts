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
  "\u001b[1;2A": "shift_up",
  "\u001b[1;2B": "shift_down",
  "\u001b[1;2C": "shift_right",
  "\u001b[1;2D": "shift_left",
  "\u001b[1;2H": "shift_home",
  "\u001b[1;2F": "shift_end",
  "\u001b[1;3C": "alt_right",
  "\u001b[1;3D": "alt_left",
  "\u001b[1;4C": "shift_alt_right",
  "\u001b[1;4D": "shift_alt_left",
  "\u001b[1;5C": "ctrl_right",
  "\u001b[1;5D": "ctrl_left",
  "\u001b[1;6C": "shift_ctrl_right",
  "\u001b[1;6D": "shift_ctrl_left",
  "\u001b[1;9C": "super_right",
  "\u001b[1;9D": "super_left",
  "\u001b[1;10C": "shift_super_right",
  "\u001b[1;10D": "shift_super_left",
  "\u001b[3;3~": "alt_delete",
  "\u001b[3;5~": "ctrl_delete",
  "\u001b\u007f": "alt_backspace",
  "\u001b\r": "alt_enter",
  "\u001bb": "alt_b",
  "\u001bd": "alt_d",
  "\u001bf": "alt_f",
  // Cmd's select all, copy and cut, as Ghostty passes them on when it has no selection of its own.
  "\u001b[97;9u": "super_a",
  "\u001b[99;9u": "super_c",
  "\u001b[120;9u": "super_x",
  "\u001b[I": "focus_in",
  "\u001b[O": "focus_out",
  "\u001b[200~": "paste_start",
  "\u001b[201~": "paste_end",
};
export type Key =
  | "alt_b"
  | "alt_backspace"
  | "alt_d"
  | "alt_delete"
  | "alt_enter"
  | "alt_f"
  | "alt_left"
  | "alt_right"
  | "ctrl_delete"
  | "ctrl_left"
  | "ctrl_right"
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
  | "shift_alt_left"
  | "shift_alt_right"
  | "shift_ctrl_left"
  | "shift_ctrl_right"
  | "shift_down"
  | "shift_end"
  | "shift_home"
  | "shift_left"
  | "shift_right"
  | "shift_super_left"
  | "shift_super_right"
  | "shift_tab"
  | "shift_up"
  | "super_a"
  | "super_c"
  | "super_left"
  | "super_right"
  | "super_x"
  | "up";
export function parse(seq: string): Key | null {
  return (map[seq] as Key) ?? null;
}
/** Whether input for a pane is a mouse report, in any encoding a pane can ask for. */
export function mouseReport(seq: string) {
  return /^\x1b\[(?:<|M|\d+;\d+;\d+M)/.test(seq);
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
  insert: 57348,
  comma: 44,
  minus: 45,
  plus: 43,
  backtick: 96,
  ampersand: 38,
};
const modifiers: Record<string, "ctrl" | "alt" | "shift" | "super"> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  super: "super",
};
/** A logical key, independent of the protocol the terminal used to send it. */
export function normalize(key: LogicalKey): LogicalKey {
  let codepoint = key.codepoint;
  const mods = { ctrl: !!key.mods.ctrl, alt: !!key.mods.alt, shift: !!key.mods.shift, super: !!key.mods.super };
  if (codepoint === 57344) codepoint = 27;
  if (codepoint === 57345) codepoint = 13;
  if (codepoint === 57346) codepoint = 9;
  if (codepoint === 57347) codepoint = 127;
  if (codepoint >= 65 && codepoint <= 90) {
    codepoint += 32;
    if (!mods.ctrl && !mods.alt && !mods.super) mods.shift = true;
  }
  if (codepoint < 27 && codepoint !== 9 && codepoint !== 13) {
    codepoint = codepoint === 0 ? 32 : codepoint + 96;
    mods.ctrl = true;
  }
  return { codepoint, mods };
}
export function same(a: LogicalKey, b: LogicalKey): boolean {
  a = normalize(a);
  b = normalize(b);
  return (
    a.codepoint === b.codepoint &&
    ["ctrl", "alt", "shift", "super"].every(
      k => !!a.mods[k as keyof LogicalKey["mods"]] === !!b.mods[k as keyof LogicalKey["mods"]],
    )
  );
}
/** Human-editable chord spelling. Prefix scope belongs to the binding. */
export function parseChord(value: string): LogicalKey | null {
  const parts = value.trim().split("+");
  const last = parts.pop();
  if (!last) return null;
  const mods: LogicalKey["mods"] = {};
  for (const part of parts) {
    const mod = modifiers[part.toLowerCase()];
    if (!mod || mods[mod]) return null;
    mods[mod] = true;
  }
  const name = last.toLowerCase();
  const functionKey = /^f([1-9]|1\d|2[0-5])$/.exec(name);
  const char = last.normalize("NFC");
  const codepoint =
    named[name] ?? (functionKey ? 57363 + Number(functionKey[1]) : [...char].length === 1 ? char.codePointAt(0)! : -1);
  if (
    codepoint < 0 ||
    (codepoint >= 128 && codepoint <= 159) ||
    (codepoint >= 57344 && codepoint <= 63743 && named[name] === undefined && !functionKey) ||
    (codepoint < 32 && ![9, 13, 27].includes(codepoint)) ||
    (codepoint >= 0xd800 && codepoint <= 0xdfff)
  )
    return null;
  return normalize({ codepoint, mods });
}
export function chordName(key: LogicalKey): string {
  const { codepoint, mods } = normalize(key);
  const name =
    Object.entries(named).find(([, value]) => value === codepoint)?.[0] ??
    (codepoint >= 57364 && codepoint <= 57388 ? `f${codepoint - 57363}` : String.fromCodePoint(codepoint));
  return (
    (mods.ctrl ? "ctrl+" : "") +
    (mods.alt ? "alt+" : "") +
    (mods.super ? "cmd+" : "") +
    (mods.shift ? "shift+" : "") +
    name
  );
}
export function logicalKey(name: string): LogicalKey {
  const parts = name.split("+");
  const key = parts.pop()!;
  const mods: Record<string, boolean> = {};
  for (const mod of parts) {
    if (!["ctrl", "alt", "shift"].includes(mod)) throw new Error("InvalidKey");
    mods[mod] = true;
  }
  const codepoint =
    named[key] ?? (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127 ? key.charCodeAt(0) : null);
  if (codepoint === null) throw new Error("InvalidKey");
  return { codepoint, mods };
}
