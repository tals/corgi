import { test, expect } from "bun:test";
import { decode, encode } from "./keyboard";
test("modified Return uses the pane keyboard protocol", () => {
  for (const seq of ["\x1b[13;2u", "\x1b[13;5u", "\x1b[13;9u", "\x1b[27u"])
    expect(encode(decode(seq)!, { kitty_flags: { disambiguate: true } })).toBe(seq);
  expect(encode(decode("\x1b[13;2u")!)).toBe("\x1b[27;2;13~");
  expect(encode(decode("\x1b[98;5u")!)).toBe("\x02");
  expect(encode(decode("\x1b[13;3u")!, { alt_esc_prefix: true })).toBe("\x1b\r");
});
test("unsupported and malformed CSI-u remains untouched", () => {
  for (const seq of [
    "\x1b[1;5A",
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
test("ordinary arrows follow the pane application cursor mode in both directions", () => {
  for (const application of [true, false])
    for (const suffix of "ABCD")
      for (const prefix of "[O")
        expect(
          encode(decode("\x1b" + prefix + suffix)!, {
            cursor_key_application: application,
          }),
        ).toBe("\x1b" + (application ? "O" : "[") + suffix);
});
test("CSI-u navigation keys use legacy and application cursor encodings", () => {
  expect(encode(decode("\x1b[57352;5u")!)).toBe("\x1b[1;5A");
  expect(encode(decode("\x1b[57350u")!, { cursor_key_application: true })).toBe("\x1bOD");
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
  expect(encode(decode("\x1bOP")!, { kitty_flags: { disambiguate: true } })).toBe("\x1b[P");
  expect(decode("\x1b[R")).toBeNull();
});
