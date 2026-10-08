// Mirrors the tests in paste_card.zig.
import { expect, test } from "bun:test";
import { keycap } from "./palette";
import { Rect } from "./layout";
import { place, draw, linkAt, styles } from "./paste_card";
import { State, nightly_url } from "./host_clipboard";

function sample() {
  const s = new State();
  s.support = "unsupported";
  s.terminalName("ghostty 1.3.1");
  return s.notice("cmd", "Codex", "nocap")!;
}

test("the card opens above the caret, or below it when the pane has no room", () => {
  const notice = sample();
  const pane = new Rect(26, 1, 80, 14);
  const above = place(notice, pane, { x: 29, y: 10 })!;
  expect(above.x).toBe(27);
  expect(above.y).toBe(1);
  expect(above.h).toBe(8);
  expect(above.arrow!.y).toBe(9);
  expect(above.arrow!.glyph).toBe("▾");
  const below = place(notice, pane, { x: 29, y: 3 })!;
  expect(below.y).toBe(5);
  expect(below.arrow!.glyph).toBe("▴");
  // Near the right edge the card stays inside the pane.
  expect(place(notice, pane, { x: 94, y: 10 })!.x).toBe(pane.x + pane.w - above.w);
  // A narrow pane shortens the download link before giving up.
  expect(place(notice, new Rect(0, 0, 60, 14), { x: 3, y: 10 })!.w).toBe(60);
  expect(place(notice, new Rect(0, 0, 30, 14), { x: 3, y: 9 })).toBeNull();
  expect(place(notice, new Rect(0, 0, 80, 8), { x: 3, y: 4 })).toBeNull();
  expect(place(notice, pane, null)!.arrow).toBeNull();
});

test("the card shows its title, close key, reason and fix with a link", () => {
  const notice = sample();
  const at = place(notice, new Rect(26, 1, 80, 14), { x: 29, y: 10 })!;
  let drawn = draw(notice, at, false);
  expect(drawn.startsWith("\x1b7")).toBe(true);
  expect(drawn.endsWith("\x1b8")).toBe(true);
  for (const part of [
    styles.title,
    keycap + " esc ",
    " close ",
    "Ghostty 1.3.1 can't send images over SSH.",
    "\x1b]8;;" + nightly_url + "\x1b\\\x1b[4mGhostty Nightly\x1b[24m",
    styles.heading + "⌘+V",
    "Download: " + styles.text + "\x1b]8;;" + nightly_url + "\x1b\\\x1b[4m" + nightly_url,
    "\x1b[10;30H" + styles.pointer + "▾",
  ])
    expect(drawn).toContain(part);
  expect(drawn).not.toContain("Copied");
  expect(drawn).toContain(styles.quiet + styles.open_hint + styles.border + "─╯");
  drawn = draw(notice, at, true);
  expect(drawn).toContain(styles.check + "✓" + styles.text + " Copied to clipboard ");
  expect(drawn).not.toContain(styles.open_hint);
});

test("both links answer the pointer, and nothing else on the card does", () => {
  const notice = sample();
  const at = place(notice, new Rect(26, 1, 80, 14), { x: 29, y: 10 })!;
  const left = at.x + 1 + 3;
  // "Use " then "Ghostty Nightly" on the fix row.
  expect(linkAt(notice, at, left + 3, at.y + 4)).toBe(false);
  expect(linkAt(notice, at, left + 4, at.y + 4)).toBe(true);
  expect(linkAt(notice, at, left + 18, at.y + 4)).toBe(true);
  expect(linkAt(notice, at, left + 19, at.y + 4)).toBe(false);
  expect(linkAt(notice, at, left + 9, at.y + 5)).toBe(false);
  expect(linkAt(notice, at, left + 10, at.y + 5)).toBe(true);
  expect(linkAt(notice, at, left + 10, at.y + 2)).toBe(false);
  const tmux = new State();
  tmux.support = "unsupported";
  tmux.terminalName("tmux 3.4");
  const plain = tmux.notice("cmd", "Codex", "nocap")!;
  const plain_at = place(plain, new Rect(26, 1, 80, 14), { x: 29, y: 10 })!;
  expect(plain_at.h).toBe(7);
  // Nothing to open, so no hint.
  expect(draw(plain, plain_at, false)).not.toContain(styles.open_hint);
});
