import { expect, test } from "bun:test";
import { Terminal } from "./terminal";
import { Screen } from "../persist/checkpoint";

const fixtures = [
  { name: "empty", text: "" },
  { name: "Unicode and styles", text: "\x1b[1;38;2;80;120;200mwide 界 👩‍💻 é\x1b[0m\r\nnext" },
  { name: "links", text: "\x1b]8;id=one;https://example.com/界\x1b\\linked\x1b]8;;\x1b\\ plain" },
  { name: "alternate screen and input modes", text: "primary\r\nhistory\x1b[?1049h\x1b[?2004h\x1b[?1000hALTERNATE" },
  {
    name: "scrolling history",
    text: Array.from({ length: 512 }, (_, i) => `line ${i} ${"x".repeat(120)}\r\n`).join(""),
  },
];

test.each(fixtures)("a recovery snapshot replays without input modes: $name", ({ text }) => {
  const source = new Terminal(132, 47),
    restored = new Terminal(132, 47);
  try {
    source.feed(text);
    for (const resize of [false, true]) {
      if (resize) source.resize(80, 24);
      const owned = source.snapshot(),
        expected = Buffer.from(owned),
        encoded = source.snapshotBase64();
      expect(encoded).toBe(expected.toString("base64"));
      expect(Screen.capture(source, false).data).toBe(encoded);
      // A second capture frees its own native storage, never a returned Buffer's.
      expect(source.snapshot()).toEqual(expected);
      expect(owned).toEqual(expected);
      restored.feed(owned);
      expect(restored.native({ op: "info" }).active_screen).toBe("primary");
      expect(restored.bracketed_paste).toBe(false);
    }
  } finally {
    source.destroy();
    restored.destroy();
  }
});

test("snapshot buffers survive feeds, later captures and destruction", () => {
  const source = new Terminal(80, 24);
  source.feed("first 界");
  const first = source.snapshot(),
    expected = Buffer.from(first);
  source.feed("\rsecond");
  expect(source.snapshot()).not.toEqual(first);
  source.destroy();
  expect(first).toEqual(expected);
  expect(() => source.snapshot()).toThrow("TerminalClosed");
  expect(() => source.snapshotBase64()).toThrow("TerminalClosed");
});
