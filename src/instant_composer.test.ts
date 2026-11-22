import { expect, test } from "bun:test";
import * as composer from "./instant_composer";
import type { Surface } from "./pane/surface";

const gray = "\x1b[0;38;2;153;153;153;48;2;40;44;52m",
  white = "\x1b[0;38;2;255;255;255;48;2;40;44;52m";

function surface(lines: string[], cursor: Surface["cursor"], cols = 40): Surface {
  return { pane: 1, cols, rows: lines.length, lines, cursor, cursor_style: "default" };
}
const row = (text: string, cols = 40) => white + text.padEnd(cols) + "\x1b[0m";
const rule = "─".repeat(40);

test("a draft takes the color of the text, not of the prompt before it", () => {
  const shape = composer.inspect(
    surface([row(""), row(rule), gray + "❯ " + white + "hi".padEnd(38) + "\x1b[0m", row(rule), row("  footer")], {
      x: 4,
      y: 2,
    }),
    "claude",
  )!;
  const projected = composer.project(shape, { text: "hi there", cursor: 8 })!;
  expect(projected.lines[2]).toStartWith(gray + "❯ " + white + "\x1b[22mhi there");
});

test("an empty box's painted caret doesn't color the draft", () => {
  const caret = "\x1b[0;38;2;40;44;52;48;2;255;255;255m";
  const shape = composer.inspect(
    surface(
      [row(""), row(rule), white + "❯ " + caret + " " + white + " ".repeat(37) + "\x1b[0m", row(rule), row("  x")],
      null,
    ),
    "claude",
  )!;
  expect(shape.cursor).toEqual({ x: 0, y: 0 });
  const projected = composer.project(shape, { text: "a", cursor: 1 })!;
  expect(projected.lines[2]).toContain(white + "\x1b[22ma");
  expect(projected.lines[2]).not.toContain(caret);
});

test("Claude's box at the top of the screen isn't projected past it", () => {
  const shape = composer.inspect(
    surface([row(rule), row("❯ aaa"), row("  bbb"), row(rule), row("  footer")], { x: 5, y: 2 }),
    "claude",
  )!;
  expect(shape.top).toBe(1);
  expect(composer.project(shape, { text: "aaa", cursor: 3 })).toBeNull();
});

/** Codex's box with its footer at the bottom of the screen, under `above`. */
function codex(above: string[], draft: string[]): Surface {
  const lines = [...above, "", ...draft.map((line, i) => (i ? "  " : "› ") + line), "", "  GPT-6 xhigh · ~/x", ""];
  const y = above.length + draft.length;
  return surface(
    lines.map(line => row(line)),
    { x: 2 + draft.at(-1)!.length, y },
  );
}
const plain = (s: Surface) => s.lines.map(line => Bun.stripANSI(line).trimEnd());

test("Codex pinned to the bottom scrolls a full transcript as its box grows and shrinks", () => {
  const transcript = ["  t1", "  t2", "  t3", "  t4", "  t5", "  t6"];
  const one = composer.inspect(codex(transcript, ["aaa"]), "codex")!;
  const grown = composer.project(one, { text: "aaa\nb", cursor: 5 })!;
  expect(plain(grown)).toEqual(plain(codex(transcript.slice(1), ["aaa", "b"])));
  const two = composer.inspect(codex(transcript.slice(1), ["aaa", "b"]), "codex")!;
  const shrunk = composer.project(two, { text: "aaa", cursor: 3 })!;
  // The transcript row that scrolls back in isn't on this screen.
  expect(plain(shrunk)).toEqual(plain(codex(["", ...transcript.slice(1)], ["aaa"])));
});

test("Codex pinned to the bottom grows into the blank rows under a short transcript", () => {
  const above = ["  header", "", "", "", "", ""];
  const one = composer.inspect(codex(above, ["aaa"]), "codex")!;
  const grown = composer.project(one, { text: "aaa\nb", cursor: 5 })!;
  expect(plain(grown)).toEqual(plain(codex(above.slice(0, -1), ["aaa", "b"])));
  const two = composer.inspect(codex(above.slice(0, -1), ["aaa", "b"]), "codex")!;
  expect(plain(composer.project(two, { text: "aaa", cursor: 3 })!)).toEqual(plain(codex(above, ["aaa"])));
});
