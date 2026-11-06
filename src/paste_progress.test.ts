import { expect, test } from "bun:test";
import { State, place, draw } from "./paste_progress";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";
import * as text from "./text";

test("upload bar stays beside the caret without covering its row or leaving the pane", () => {
  for (const pane of [new Rect(28, 1, 40, 24), new Rect(6, 2, 14, 2)]) {
    for (const x of [pane.x, pane.x + pane.w - 1])
      for (const y of [pane.y, pane.y + pane.h - 1]) {
        const at = place(pane, { x, y })!;
        expect(at.y).not.toBe(y);
        expect(pane.contains(at.x, at.y)).toBe(true);
        expect(pane.contains(at.x + at.w - 1, at.y)).toBe(true);
      }
  }
  expect(place(new Rect(0, 0, 13, 24), { x: 0, y: 0 })).toBeNull();
  expect(place(new Rect(0, 0, 40, 1), { x: 0, y: 0 })).toBeNull();
  expect(place(new Rect(0, 0, 40, 24), { x: 40, y: 0 })).toBeNull();
});

test("progress is an overlay: it preserves the caret, typing row and all other cells", () => {
  const screen = new Terminal(40, 10);
  const state = new State(1);
  const pane = new Rect(0, 0, 40, 10);
  const at = place(pane, { x: 6, y: 5 })!;
  const base =
    "\x1b[2J" + Array.from({ length: 10 }, (_, i) => `\x1b[${i + 1};1H${String(i).repeat(39)}`).join("") + "\x1b[6;7H";
  try {
    screen.feed(base);
    const before = screen.surface(0).surface;
    state.update(512, 1024);
    screen.feed(draw(state, at));
    const after = screen.surface(0).surface;
    expect(after.cursor).toEqual(before.cursor);
    expect(Bun.stripANSI(after.lines[at.y])).toContain("50%");
    for (let y = 0; y < 10; y++) {
      if (y !== at.y) expect(after.lines[y]).toBe(before.lines[y]);
      else {
        expect(Bun.stripANSI(after.lines[y]).slice(0, at.x)).toBe(Bun.stripANSI(before.lines[y]).slice(0, at.x));
        expect(Bun.stripANSI(after.lines[y]).slice(at.x + at.w)).toBe(
          Bun.stripANSI(before.lines[y]).slice(at.x + at.w),
        );
      }
    }
    screen.feed(base);
    expect(screen.surface(0).surface.lines).toEqual(before.lines);
  } finally {
    screen.destroy();
  }
});

test("preparing, uploading and completion keep a fixed footprint, with no spinner or fake percentage", () => {
  const state = new State(1);
  for (const width of [14, 22]) {
    const at = new Rect(0, 0, width, 1);
    for (const phase of ["preparing", "uploading", "attaching", "done", "failed"] as const) {
      state.phase = phase;
      state.received = 620;
      state.total = 1000;
      const shown = Bun.stripANSI(draw(state, at, 100));
      expect(text.displayWidth(shown)).toBe(width);
      if (phase === "uploading") expect(shown).toContain("62%");
      else expect(shown).not.toContain("%");
    }
  }
  state.finish(true, 100);
  expect(state.until).toBe(1000);
  state.finish(false, 100);
  expect(state.until).toBe(3100);
});
