import { expect, test } from "bun:test";
import { Differ } from "./frame_diff";

const render = (d: Differ, frame: string) => d.diff(frame).toString();

test("a frame that changes one cell writes that cell", () => {
  const d = Differ.create(20, 4);
  const first = "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mworld\x1b[0m\x1b[?2026l";
  expect(render(d, first)).toBe(first);
  expect(render(d, first)).toBe("");
  expect(render(d, "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mwOrld\x1b[0m\x1b[?2026l")).toBe(
    "\x1b[?2026h\x1b[?25l\x1b[2;2H\x1b[0m\x1b[38;5;1mO\x1b[0m\x1b[2;6H\x1b[?25h\x1b[?2026l",
  );
  d.destroy();
});

test("a changed control sends the whole frame", () => {
  const d = Differ.create(20, 4);
  for (const frame of [
    "\x1b[H\x1b[Jtext\x1b]22;default\x1b\\",
    "\x1b[H\x1b[Jtext\x1b]22;pointer\x1b\\",
    "\x1b[H\x1b[J\x1b[2;3H\x1b_Ga=p,i=1\x1b\\text",
    "\x1b[H\x1b[J\x1b[3;3H\x1b_Ga=p,i=1\x1b\\text",
  ])
    expect(render(d, frame)).toBe(frame);
  d.destroy();
});

test("a moved cursor is written without cells", () => {
  const d = Differ.create(20, 4);
  render(d, "\x1b[H\x1b[J$ \x1b[1;3H\x1b[?25h");
  expect(render(d, "\x1b[H\x1b[J$ \x1b[2;5H\x1b[?25h")).toBe("\x1b[?2026h\x1b[?25l\x1b[2;5H\x1b[?25h\x1b[?2026l");
  d.destroy();
});

test("wide characters and links are rewritten whole", () => {
  const d = Differ.create(20, 2);
  render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://a.example\x1b\\ab\x1b]8;;\x1b\\界c");
  const changed = render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界d");
  expect(changed).toContain("\x1b]8;id=x;https://b.example\x1b\\");
  expect(changed).toContain("界d");
  const tail = render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界e");
  expect(tail).toContain("\x1b[1;5H");
  expect(tail).not.toContain("界");
  d.destroy();
});
