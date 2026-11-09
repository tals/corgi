import { expect, test } from "bun:test";
import { draw } from "./sync_notice";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";

test("the notice covers only its pane's top rows", () => {
  const screen = new Terminal(60, 8);
  const pane = new Rect(10, 1, 40, 6);
  const base = "\x1b[2J" + Array.from({ length: 8 }, (_, i) => `\x1b[${i + 1};1H${String(i).repeat(59)}`).join("");
  try {
    screen.feed(base);
    const before = screen.surface(0).surface;
    screen.feed(
      draw({ status: "work: Syncing… 2s · 3 keys waiting", keys: "Ctrl+R retry · Ctrl+X pause · ! details" }, pane),
    );
    const after = screen.surface(0).surface.lines.map(line => Bun.stripANSI(line));
    expect(after[1].slice(10, 50)).toContain("work: Syncing… 2s · 3 keys waiting");
    expect(after[2].slice(10, 50)).toContain("Ctrl+R retry");
    for (const y of [1, 2]) {
      expect(after[y].slice(0, 10)).toBe(Bun.stripANSI(before.lines[y]).slice(0, 10));
      expect(after[y].slice(50)).toBe(Bun.stripANSI(before.lines[y]).slice(50));
    }
    for (const y of [0, 3, 4, 5, 6, 7]) expect(after[y]).toBe(Bun.stripANSI(before.lines[y]));
  } finally {
    screen.destroy();
  }
});

test("a one-row pane shows the status alone, clipped to its width", () => {
  const screen = new Terminal(20, 3);
  try {
    screen.feed(draw({ status: "work: Connection stalled (12s)", keys: "Ctrl+R retry" }, new Rect(0, 0, 12, 1)));
    const lines = screen.surface(0).surface.lines.map(line => Bun.stripANSI(line));
    expect(lines[0].trimEnd()).toMatch(/…$/);
    expect(lines[1].trim()).toBe("");
  } finally {
    screen.destroy();
  }
});
