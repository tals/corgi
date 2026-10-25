import { test, expect } from "bun:test";
import { validName, max_name, submit } from "./agent_rename";
import { Terminal } from "./pane/terminal";

test("names are one printable line", () => {
  expect(validName("refactor ⑂")).toBe(true);
  expect(validName(new Uint8Array([0xff]))).toBe(false);
  for (const name of ["", "two\nlines", "bell\x07", "\udfff", "x".repeat(max_name + 1)])
    expect(validName(name)).toBe(false);
});
test("automated submissions use the agent's current keyboard protocol", async () => {
  const terminal = new Terminal(80, 24);
  try {
    for (const [mode, expected] of [
      ["", "\r"],
      ["\x1b[>9u", "\x1b[13u"],
      ["\x1b[<u", "\r"],
    ]) {
      terminal.feed(mode);
      await submit(terminal);
      expect(terminal.native({ op: "takePending" })).toBe(expected);
    }
  } finally {
    terminal.destroy();
  }
});
