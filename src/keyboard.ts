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
/** One logical text key. A split UTF-8 character waits for the next read. */
export function textKey(bytes: readonly number[]): { key: Key | null; length: number } {
  if (!bytes.length) return { key: null, length: 0 };
  const first = bytes[0];
  const length =
    first < 128
      ? 1
      : first >= 194 && first <= 223
        ? 2
        : first <= 239 && first >= 224
          ? 3
          : first >= 240 && first <= 244
            ? 4
            : 1;
  if (bytes.length < length) return { key: null, length: 0 };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(bytes.slice(0, length)),
    );
    return { key: { codepoint: text.codePointAt(0)!, mods: {} }, length };
  } catch {
    return { key: null, length: 1 };
  }
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
const letter_keys: Record<string, number> = {
  A: arrow_up,
  B: arrow_down,
  C: arrow_right,
  D: arrow_left,
  E: 57427,
  H: 57356,
  F: 57357,
  P: f1,
  Q: f1 + 1,
  S: f1 + 3,
};
const tilde_keys: Record<number, number> = {
  1: 57356,
  2: 57348,
  3: 57349,
  4: 57357,
  5: 57354,
  6: 57355,
  7: 57356,
  8: 57357,
  11: f1,
  12: f1 + 1,
  13: f1 + 2,
  14: f1 + 3,
  15: f1 + 4,
  17: f1 + 5,
  18: f1 + 6,
  19: f1 + 7,
  20: f1 + 8,
  21: f1 + 9,
  23: f1 + 10,
  24: f1 + 11,
  29: 57363,
  57427: 57427,
};
// Decode functional keys as well as CSI-u so the child's keyboard protocol
// and application cursor mode determine their encoding, including lock bits.
// Reject extensions we did not request instead of losing fields.
export function decode(bytes: string): Key | null {
  if (bytes === "\x1b[Z") return { codepoint: 9, mods: { shift: true } };
  if (bytes.length === 3 && bytes[0] === "\x1b" && (bytes[1] === "[" || bytes[1] === "O")) {
    if (bytes[2] === "R") return bytes[1] === "O" ? { codepoint: f1 + 2, mods: {} } : null;
    const cp = letter_keys[bytes[2]];
    return cp === undefined ? null : { codepoint: cp, mods: {} };
  }
  // CSI row;col R is a cursor-position reply, not a modified F3.
  const m = /^\x1b\[([+]?\d+)(?:;([+]?\d+))?([u~ABCDEFHPQS])$/.exec(bytes);
  if (!m) return null;
  const value = Number(m[1]);
  let cp: number | undefined;
  switch (m[3]) {
    case "u":
      cp = value;
      break;
    case "~":
      cp = tilde_keys[value];
      break;
    default:
      cp = value === 1 ? letter_keys[m[3]] : undefined;
      break;
  }
  if (cp === undefined) return null;
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
/** The sequence Corgi's text boxes read for a key whose legacy encoding
 * loses what they need: word and line deletion, word moves typed with alt,
 * Enter with shift or alt, and cmd's select all, copy and cut. Null for any
 * other key. */
export function editSequence(key: Key): string | null {
  const { shift, alt, ctrl } = key.mods,
    cmd = !!key.mods.super;
  switch (key.codepoint) {
    case 127:
      return cmd ? "\x15" : alt || ctrl ? "\x1b\x7f" : null;
    case 13:
      return shift || alt ? "\x1b\r" : null;
    case 98:
    case 100:
    case 102:
      return alt && !ctrl && !cmd ? "\x1b" + String.fromCharCode(key.codepoint) : null;
    case 97:
    case 99:
    case 120:
      return cmd && !alt && !ctrl && !shift ? `\x1b[${key.codepoint};9u` : null;
    default:
      return null;
  }
}
