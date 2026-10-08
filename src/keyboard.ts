export const enable = "\x1b[>1u",
  disable = "\x1b[<u";
export const arrow_left = 57350,
  arrow_right = 57351,
  arrow_up = 57352,
  arrow_down = 57353,
  f1 = 57364;
export interface Mods {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  super?: boolean;
  caps_lock?: boolean;
  num_lock?: boolean;
}
export interface Key {
  codepoint: number;
  mods: Mods;
}
/** Kitty's functional key codes Ghostty encodes; others stay unparsed. */
function functional(cp: number): boolean {
  return (
    [27, 13, 9, 127].includes(cp) ||
    (cp >= 57344 && cp <= 57388) ||
    (cp >= 57399 && cp <= 57427) ||
    [57441, 57442, 57443, 57444, 57447, 57448, 57449, 57450].includes(cp)
  );
}
// Decode ordinary cursor keys as well as CSI-u so the child's application
// cursor mode, rather than the host's mode, determines their encoding.
// Reject extensions we did not request instead of losing fields.
export function decode(bytes: string): Key | null {
  if (bytes.length === 3 && bytes[0] === "\x1b" && (bytes[1] === "[" || bytes[1] === "O")) {
    const cps: Record<string, number> = {
      A: arrow_up,
      B: arrow_down,
      C: arrow_right,
      D: arrow_left,
      P: f1,
      Q: f1 + 1,
      S: f1 + 3,
    };
    if (bytes[2] === "R") return bytes[1] === "O" ? { codepoint: f1 + 2, mods: {} } : null;
    const cp = cps[bytes[2]];
    return cp === undefined ? null : { codepoint: cp, mods: {} };
  }
  const m = /^\x1b\[([+]?\d+)(?:;([+]?\d+))?u$/.exec(bytes);
  if (!m) return null;
  const cp = Number(m[1]);
  if (!Number.isSafeInteger(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  // Kitty reserves this private-use block for functional keys. Unknown
  // functions must stay encoded, never turn into private-use text.
  if (cp >= 57344 && cp <= 63743 && !functional(cp)) return null;
  const parameter = m[2] === undefined ? 1 : Number(m[2]);
  if (parameter === 0 || parameter > 256) return null;
  const bits = parameter - 1;
  // Ghostty has no Hyper/Meta representation; preserve those sequences.
  if (bits & 48) return null;
  return {
    codepoint: cp,
    mods: {
      shift: !!(bits & 1),
      alt: !!(bits & 2),
      ctrl: !!(bits & 4),
      super: !!(bits & 8),
      caps_lock: !!(bits & 64),
      num_lock: !!(bits & 128),
    },
  };
}
export function encode(
  key: Key,
  options: {
    kitty?: boolean;
    application_cursor?: boolean;
    alt_escape?: boolean;
    kitty_flags?: { disambiguate?: boolean };
    cursor_key_application?: boolean;
    alt_esc_prefix?: boolean;
  } = {},
): string {
  const bits = (key.mods.shift ? 1 : 0) | (key.mods.alt ? 2 : 0) | (key.mods.ctrl ? 4 : 0) | (key.mods.super ? 8 : 0),
    kitty = options.kitty || options.kitty_flags?.disambiguate,
    application = options.application_cursor || options.cursor_key_application;
  const cp = ({ 57344: 27, 57345: 13, 57346: 9, 57347: 127 } as Record<number, number>)[key.codepoint] ?? key.codepoint;
  const arrows: Record<number, string> = {
    [arrow_up]: "A",
    [arrow_down]: "B",
    [arrow_right]: "C",
    [arrow_left]: "D",
    57356: "H",
    57357: "F",
  };
  if (arrows[cp]) return bits ? `\x1b[1;${bits + 1}${arrows[cp]}` : `\x1b${application ? "O" : "["}${arrows[cp]}`;
  if (cp >= f1 && cp <= f1 + 3)
    return bits
      ? `\x1b[1;${bits + 1}${String.fromCharCode(80 + cp - f1)}`
      : `\x1b${kitty ? "[" : "O"}${String.fromCharCode(80 + cp - f1)}`;
  const numbered: Record<number, number> = {
    57348: 2,
    57349: 3,
    57354: 5,
    57355: 6,
    57368: 15,
    57369: 17,
    57370: 18,
    57371: 19,
    57372: 20,
    57373: 21,
    57374: 23,
    57375: 24,
  };
  if (numbered[cp]) return `\x1b[${numbered[cp]}${bits ? ";" + (bits + 1) : ""}~`;
  if (kitty && (bits || cp === 27)) return `\x1b[${cp}${bits ? ";" + (bits + 1) : ""}u`;
  if (cp === 13 && bits && (bits !== 2 || !(options.alt_escape || options.alt_esc_prefix)))
    return `\x1b[27;${bits + 1};13~`;
  if (cp === 9 && key.mods.shift && !key.mods.ctrl && !key.mods.alt) return "\x1b[Z";
  let text = String.fromCodePoint(cp);
  if (key.mods.ctrl && cp >= 64 && cp <= 127) text = String.fromCharCode(cp & 31);
  return (key.mods.alt ? "\x1b" : "") + text;
}
