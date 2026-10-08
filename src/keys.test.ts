import { test, expect } from "bun:test";
import { parse, logicalKey, paste_start, paste_end } from "./keys";
import { decode } from "./keyboard";
test("parse recognizes CSI and SS3 forms, and rejects the unmapped", () => {
  for (const [seq, key] of [
    ["\x1b[A", "up"],
    ["\x1bOA", "up"],
    ["\x1b[C", "right"],
    ["\x1bOC", "right"],
    ["\x1b[D", "left"],
    ["\x1bOD", "left"],
    ["\x1b[1~", "home"],
    ["\x1b[4~", "end"],
    ["\x1b[3~", "delete"],
    ["\x1b[Z", "shift_tab"],
    [paste_start, "paste_start"],
    [paste_end, "paste_end"],
    ["\x1bOB", "down"],
  ] as const)
    expect(parse(seq)).toBe(key);
  expect(parse("\x1b[9~")).toBeNull();
  expect(parse("")).toBeNull();
});
test("logical CLI modifiers parse once", () => {
  expect(logicalKey("ctrl+alt+c")).toEqual({
    codepoint: 99,
    mods: { ctrl: true, alt: true },
  });
  expect(() => logicalKey("meta+x")).toThrow("InvalidKey");
});
test("kitty decoder preserves unsupported extensions", () => {
  expect(decode("\x1b[97;5u")?.mods.ctrl).toBe(true);
  for (const seq of ["\x1b[97;0u", "\x1b[97;33u", "\x1b[97;5:2u", "\x1b[57390u", "\x1b[R"])
    expect(decode(seq)).toBeNull();
});
