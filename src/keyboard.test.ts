import { afterEach, test, expect } from "bun:test";
import { decode, editSequence, textKey, type Key } from "./keyboard";
import * as viewerNative from "./viewer_native";
import { Terminal } from "./pane/terminal";

test("text keys preserve a UTF-8 BOM and wait for its complete encoding", () => {
  expect(textKey([0xef, 0xbb])).toEqual({ key: null, length: 0 });
  expect(textKey([0xef, 0xbb, 0xbf, 97])).toEqual({ key: { codepoint: 0xfeff, mods: {} }, length: 3 });
});

const terminals: Terminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.destroy();
});
function pane(modes: string) {
  const terminal = new Terminal(80, 24);
  terminal.feed(modes);
  terminals.push(terminal);
  return terminal;
}
function encode(key: Key, terminal: Terminal | null = null) {
  return viewerNative.encodeKey(terminal?.handle ?? null, key);
}
test("modified Return uses the pane keyboard protocol", () => {
  for (const seq of ["\x1b[13;2u", "\x1b[13;5u", "\x1b[13;9u", "\x1b[27u"])
    expect(encode(decode(seq)!, pane("\x1b[>1u"))).toBe(seq);
  expect(encode(decode("\x1b[13;2u")!)).toBe("\x1b[27;2;13~");
  expect(encode(decode("\x1b[98;5u")!)).toBe("\x02");
  expect(encode(decode("\x1b[13;3u")!, pane("\x1b[?1036h"))).toBe("\x1b\r");
});
test("unsupported and malformed CSI-u remains untouched", () => {
  for (const seq of [
    "\x1b[?1u",
    "\x1b[13;0u",
    "\x1b[13;257u",
    "\x1b[13;2:3u",
    "\x1b[13:10;2u",
    "\x1b[55296u",
    "\x1b[1114112u",
    "\x1b[13;17u",
  ])
    expect(decode(seq)).toBeNull();
});
test("Kitty functional keys retain locks when decoded and drop them for legacy panes", () => {
  for (const [sequence, codepoint, legacy] of [
    ["1A", 57352, "\x1b[A"],
    ["1B", 57353, "\x1b[B"],
    ["1C", 57351, "\x1b[C"],
    ["1D", 57350, "\x1b[D"],
    ["1H", 57356, "\x1b[H"],
    ["1F", 57357, "\x1b[F"],
    ["1E", 57427, "\x1b[E"],
    ["2~", 57348, "\x1b[2~"],
    ["3~", 57349, "\x1b[3~"],
    ["5~", 57354, "\x1b[5~"],
    ["6~", 57355, "\x1b[6~"],
    ["1P", 57364, "\x1bOP"],
    ["1Q", 57365, "\x1bOQ"],
    ["13~", 57366, "\x1bOR"],
    ["1S", 57367, "\x1bOS"],
    ["15~", 57368, "\x1b[15~"],
    ["24~", 57375, "\x1b[24~"],
    ["29~", 57363, "\x1b[29~"],
    ["57427~", 57427, "\x1b[E"],
  ] as const) {
    for (const bits of [64, 128, 192]) {
      const key = decode(`\x1b[${sequence.slice(0, -1)};${bits + 1}${sequence.at(-1)}`);
      expect(key).toMatchObject({
        codepoint,
        mods: { caps_lock: !!(bits & 64), num_lock: !!(bits & 128) },
      });
      expect(encode(key!)).toBe(legacy);
    }
  }
  expect(encode(decode("\x1b[1;133D")!)).toBe("\x1b[1;5D");
  expect(encode(decode("\x1b[1;130A")!)).toBe("\x1b[1;2A");
});
test("functional key decoding preserves terminal replies and unsupported extensions", () => {
  for (const sequence of [
    "\x1b[1;2R",
    "\x1b[2;129A",
    "\x1b[1;0A",
    "\x1b[1;257A",
    "\x1b[1;17A",
    "\x1b[1;33A",
    "\x1b[1;129:3A",
    "\x1b[3;129:2~",
    "\x1b[200~",
    "\x1b[201~",
    "\x1b[99;129~",
    "\x1b[?1u",
    "\x1b[?1;2c",
    "\x1b[6;20;10t",
    "\x1b[I",
    "\x1b[O",
    "\x1b[<0;10;10M",
    "\x1b[M !!",
    "\x1b[97;1;97u",
    "\x1b[1;129",
    "\x1b[1;129Aextra",
  ])
    expect(decode(sequence)).toBeNull();
});
test("navigation modifiers survive translation while locks follow the destination protocol", () => {
  const normal = pane(""),
    application = pane("\x1b[?1h"),
    kitty = pane("\x1b[>1u");
  for (const suffix of "ABCDFH") {
    for (let modifiers = 0; modifiers < 16; modifiers++) {
      for (const locks of [0, 64, 128, 192]) {
        const bits = modifiers | locks,
          sequence = `\x1b[1;${bits + 1}${suffix}`,
          key = decode(sequence)!;
        expect(key.mods).toEqual({
          shift: !!(modifiers & 1),
          alt: !!(modifiers & 2),
          ctrl: !!(modifiers & 4),
          super: !!(modifiers & 8),
          caps_lock: !!(locks & 64),
          num_lock: !!(locks & 128),
        });
        const modified = `\x1b[1;${modifiers + 1}${suffix}`;
        expect(encode(key, normal)).toBe(modifiers ? modified : `\x1b[${suffix}`);
        expect(encode(key, application)).toBe(modifiers ? modified : `\x1bO${suffix}`);
        expect(encode(key, kitty)).toBe(bits ? sequence : `\x1b[${suffix}`);
      }
    }
  }
});
test("functional key aliases normalize before encoding for the pane", () => {
  const kitty = pane("\x1b[>1u");
  for (const [aliases, codepoint, expected] of [
    [["[H", "OH", "[1~", "[7~"], 57356, "\x1b[1;129H"],
    [["[F", "OF", "[4~", "[8~"], 57357, "\x1b[1;129F"],
    [["[P", "OP", "[11~"], 57364, "\x1b[1;129P"],
    [["[Q", "OQ", "[12~"], 57365, "\x1b[1;129Q"],
    [["OR", "[13~"], 57366, "\x1b[13;129~"],
    [["[S", "OS", "[14~"], 57367, "\x1b[1;129S"],
    [["[E", "OE", "[57427~"], 57427, "\x1b[57427;129u"],
  ] as const) {
    for (const alias of aliases) {
      const key = decode("\x1b" + alias)!;
      expect(key.codepoint).toBe(codepoint);
      expect(encode({ ...key, mods: { num_lock: true } }, kitty)).toBe(expected);
    }
  }
  const backtab = decode("\x1b[Z")!;
  expect(backtab).toEqual({ codepoint: 9, mods: { shift: true } });
  expect(encode(backtab)).toBe("\x1b[Z");
  expect(encode(backtab, kitty)).toBe("\x1b[9;2u");
});
test("ordinary arrows follow the pane application cursor mode in both directions", () => {
  for (const application of [true, false])
    for (const suffix of "ABCD")
      for (const prefix of "[O")
        expect(encode(decode("\x1b" + prefix + suffix)!, pane(application ? "\x1b[?1h" : "\x1b[?1l"))).toBe(
          "\x1b" + (application ? "O" : "[") + suffix,
        );
});
test("CSI-u navigation keys use legacy and application cursor encodings", () => {
  expect(encode(decode("\x1b[57352;5u")!)).toBe("\x1b[1;5A");
  expect(encode(decode("\x1b[57350u")!, pane("\x1b[?1h"))).toBe("\x1bOD");
});
test("CSI-u function keys are encoded as keys rather than private-use text", () => {
  expect(encode(decode("\x1b[57364u")!)).toBe("\x1bOP");
  expect(encode(decode("\x1b[57375u")!)).toBe("\x1b[24~");
  expect(decode("\x1b[57398u")).toBeNull();
});
test("F1 to F4 arrive in either host form and leave in the pane's", () => {
  for (const [incoming, expected] of [
    ["\x1bOP", "\x1bOP"],
    ["\x1b[P", "\x1bOP"],
    ["\x1b[Q", "\x1bOQ"],
    ["\x1bOR", "\x1bOR"],
    ["\x1b[S", "\x1bOS"],
  ])
    expect(encode(decode(incoming)!)).toBe(expected);
  expect(encode(decode("\x1bOP")!, pane("\x1b[>1u"))).toBe("\x1b[P");
  expect(decode("\x1b[R")).toBeNull();
});

test("keys whose legacy encoding loses an edit get the sequence text boxes read", () => {
  const key = (codepoint: number, mods: Parameters<typeof editSequence>[0]["mods"]) =>
    editSequence({ codepoint, mods });
  expect(key(127, { alt: true })).toBe("\x1b\x7f");
  expect(key(127, { ctrl: true })).toBe("\x1b\x7f");
  expect(key(127, { super: true })).toBe("\x15");
  expect(key(13, { shift: true })).toBe("\x1b\r");
  expect(key(98, { alt: true })).toBe("\x1bb");
  expect(key(99, { super: true })).toBe("\x1b[99;9u");
  expect(key(99, { super: true, shift: true })).toBeNull();
  expect(key(127, {})).toBeNull();
  expect(key(97, { ctrl: true })).toBeNull();
});
