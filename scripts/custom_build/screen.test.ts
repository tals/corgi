import { expect, test } from "bun:test";
import { Screen } from "./screen";
import * as term from "./term";

const on = "\x1b[?2026h",
  off = "\x1b[?2026l";

/** A screen writing into `out`, at 24 rows and 80 columns unless told otherwise. */
function fake(o: { rows?: number; cols?: number; verbose?: boolean } = {}) {
  const out: string[] = [],
    size = { rows: o.rows ?? 24, cols: o.cols ?? 80 };
  const screen = new Screen({
    write: s => out.push(s),
    rows: () => size.rows,
    cols: () => size.cols,
    verbose: o.verbose ?? false,
  });
  return { out, size, screen, all: () => out.join("") };
}

test("terminal sequences", () => {
  expect(term.sync(true)).toBe("\x1b[?2026h");
  expect(term.sync(false)).toBe("\x1b[?2026l");
  expect(term.cursor(true)).toBe("\x1b[?25h");
  expect(term.cursor(false)).toBe("\x1b[?25l");
  expect(term.tabProgress("on", 42)).toBe("\x1b]9;4;1;42\x07");
  expect(term.tabProgress("error", 70)).toBe("\x1b]9;4;2;70\x07");
  expect(term.tabProgress("off")).toBe("\x1b]9;4;0;\x07");
  expect(term.tabProgress("on", 140.6)).toBe("\x1b]9;4;1;100\x07");
  expect(term.notify("custom-build: built")).toBe("\x1b]9;custom-build: built\x07");
  expect(term.notify("a\x07b\x1bc\nd")).toBe("\x1b]9;abc d\x07");
  expect(term.scrollRegion(6, 24)).toBe("\x1b[6;24r");
  expect(term.scrollRegion(1, null)).toBe("\x1b[r");
  // The region reset homes the cursor, so it goes between save and restore.
  expect(term.restore()).toBe("\x1b[?25h\x1b]9;4;0;\x07\x1b7\x1b[r\x1b8\x1b[?2026l");
});

test("redraw replaces the previous frame in place", () => {
  const { out, screen } = fake();
  screen.draw(["a", "b"]);
  screen.draw(["c"]);
  expect(out).toHaveLength(2);
  for (const w of out) {
    expect(w.startsWith(on)).toBe(true);
    expect(w.endsWith(off)).toBe(true);
  }
  expect(out[0]).toContain("\x1b[?25l");
  expect(out[0]).toContain("a\nb\n");
  expect(out[0]).not.toContain("\x1b[0J");
  expect(out[1].slice(on.length).startsWith("\x1b[2A")).toBe(true);
  expect(out[1]).toContain("\x1b[0J");
  expect(out[1]).toContain("c\n");
  screen.draw(["d", "e", "f"]);
  expect(out[2].slice(on.length).startsWith("\x1b[1A")).toBe(true);
});

test("a frame taller than the terminal is cut", () => {
  const { all, screen } = fake();
  screen.draw(Array.from({ length: 40 }, (_, i) => `line ${i}`));
  const drawn = all()
    .split("\n")
    .filter(l => l.includes("line "));
  expect(drawn).toHaveLength(23);
  expect(all()).toContain("line 22\n");
  expect(all()).not.toContain("line 23");
});

test("a narrower terminal erases the rows the old frame rewrapped into", () => {
  const { out, size, screen } = fake();
  screen.draw(["x".repeat(70), "\x1b[31my\x1b[0m", "z".repeat(80)]);
  size.cols = 40;
  // 70 cells take 2 rows at 40 columns, the colored y 1, 80 cells 2.
  screen.draw(["w"]);
  expect(out[1].slice(on.length).startsWith("\x1b[5A\x1b[0J")).toBe(true);
  expect(out[1]).toContain("w\n");
  // At the same width again, it moves up exactly the frame's lines.
  screen.draw(["v"]);
  expect(out[2].slice(on.length).startsWith("\x1b[1A\x1b[0J")).toBe(true);
});

test("a wider or shorter terminal erases one row per line", () => {
  const { out, size, screen } = fake({ cols: 40 });
  screen.draw(["x".repeat(40), "y"]);
  size.cols = 120;
  screen.draw(["w"]);
  expect(out[1].slice(on.length).startsWith("\x1b[2A\x1b[0J")).toBe(true);
  size.rows = 10;
  screen.draw(["v"]);
  expect(out[2].slice(on.length).startsWith("\x1b[1A\x1b[0J")).toBe(true);
});

test("a resized terminal repaints a pinned frame and the end of its log", () => {
  const { out, size, screen } = fake({ verbose: true, rows: 12 });
  screen.draw(["1", "2"]);
  screen.log(Array.from({ length: 20 }, (_, i) => `log ${i}`));
  screen.draw(["1", "2"]);
  // Same size: only the frame's rows are drawn.
  expect(out.at(-1)).not.toContain("\x1b[12;1H\x1b[2K");
  size.cols = 50;
  screen.draw(["1", "2"]);
  const w = out.at(-1) ?? "";
  // Every row is cleared, the frame drawn, then the last 10 log lines below it.
  for (let row = 3; row <= 12; row++) expect(w).toContain(`\x1b[${row};1H\x1b[2K`);
  expect(w).toContain("\x1b[1;1H\x1b[2K1");
  expect(w).toContain("\x1b[3;12r");
  expect(w).toContain("\x1b[3;1H\x1b[2Klog 10\n");
  expect(w).toContain("log 19\n");
  expect(w).not.toContain("log 9\n");
  // The repaint doesn't add to what the finish replays.
  screen.finish(["done"]);
  expect((out.at(-1) ?? "").split("log 19\n")).toHaveLength(2);
});

test("verbose pins the frame and scrolls the log below it", () => {
  const { all, out, screen } = fake({ verbose: true });
  screen.draw(["1", "2", "3", "4", "5"]);
  expect(out[0]).toContain("\n".repeat(24));
  expect(out[0].startsWith(on)).toBe(true);
  expect(out[0].endsWith(off)).toBe(true);
  expect(out[0]).toContain("\x1b[1;1H\x1b[2K1");
  expect(out[0]).toContain("\x1b[5;1H\x1b[2K5");
  screen.log(["x"]);
  const text = all();
  expect(text).toContain("\x1b[6;24r");
  expect(text.indexOf("x")).toBeGreaterThan(text.indexOf("\x1b[6;24r"));
  expect(out.at(-1)).toContain("\x1b[6;1H\x1b[2Kx\n");
});

test("verbose log lines follow each other and stay in the region", () => {
  const { out, screen } = fake({ verbose: true, rows: 10 });
  screen.draw(["f1", "f2"]);
  screen.log(["a", "b"]);
  expect(out.at(-1)).toContain("\x1b[3;1H\x1b[2Ka\n");
  expect(out.at(-1)).toContain("b\n");
  screen.log(["c".repeat(100)]);
  // 100 cells at 80 columns take two rows: a, b, then c from row 5 to 6.
  screen.log(["d"]);
  expect(out.at(-1)).toContain("\x1b[7;1H\x1b[2Kd\n");
  screen.log(["e", "f", "g", "h", "i"]);
  screen.log(["j"]);
  // The log never goes below the last row: the region scrolls instead.
  expect(out.at(-1)).toContain("\x1b[10;1H\x1b[2Kj\n");
});

test("verbose log lines lose control characters and keep colors", () => {
  const { out, screen } = fake({ verbose: true });
  screen.draw(["f"]);
  screen.log(["a\tb", "50%\r100%", "\x1b[31mred\x1b[0m\x1b[2J\x07"]);
  const w = out.at(-1) ?? "";
  expect(w).toContain("a       b\n");
  expect(w).toContain("100%\n");
  expect(w).not.toContain("50%");
  expect(w).toContain("\x1b[31mred\x1b[0m\n");
  expect(w).not.toContain("\x1b[2J");
  expect(w).not.toContain("\x07");
});

test("a verbose frame leaves room for the log", () => {
  const { all, screen } = fake({ verbose: true });
  screen.draw(Array.from({ length: 30 }, (_, i) => `line ${i}`));
  expect(all()).toContain("line 18");
  expect(all()).not.toContain("line 19");
  expect(all()).toContain("\x1b[20;24r");
});

test("a growing verbose frame moves the region and the log below it", () => {
  const { out, screen } = fake({ verbose: true });
  screen.draw(["1", "2"]);
  screen.log(["a"]);
  screen.draw(["1", "2", "3", "4"]);
  expect(out.at(-1)).toContain("\x1b[5;24r");
  screen.log(["b"]);
  expect(out.at(-1)).toContain("\x1b[5;1H\x1b[2Kb\n");
});

test("log before the first verbose draw shows once the frame is pinned", () => {
  const { all, out, screen } = fake({ verbose: true });
  screen.log(["early"]);
  expect(out).toHaveLength(0);
  screen.draw(["f"]);
  expect(all()).toContain("\x1b[2;1H\x1b[2Kearly\n");
});

test("log is ignored outside verbose", () => {
  const { out, screen } = fake();
  screen.draw(["a"]);
  screen.log(["x"]);
  expect(out).toHaveLength(1);
});

test("a resize sends the scroll region again before the next log line", () => {
  const { out, size, screen } = fake({ verbose: true });
  screen.draw(["1", "2"]);
  expect(out[0]).toContain("\x1b[3;24r");
  screen.log(["a"]);
  expect(out.at(-1)).not.toContain("\x1b[3;24r");
  size.cols = 60;
  screen.log(["b"]);
  const w = out.at(-1) ?? "";
  expect(w).toContain("\x1b[3;24r");
  expect(w.indexOf("\x1b[3;24r")).toBeLessThan(w.indexOf("b"));
  size.rows = 20;
  screen.draw(["1", "2"]);
  expect(out.at(-1)).toContain("\x1b[3;20r");
  screen.log(["c"]);
  expect(out.at(-1)).not.toMatch(/\x1b\[\d+;\d+r/);
});

test("a shorter terminal keeps the next log line on screen", () => {
  const { out, size, screen } = fake({ verbose: true });
  screen.draw(["1"]);
  screen.log(Array.from({ length: 30 }, (_, i) => `l${i}`));
  size.rows = 12;
  screen.log(["x"]);
  expect(out.at(-1)).toContain("\x1b[2;12r\x1b[12;1H\x1b[2Kx\n");
});

test("kept lines come back in the scrollback with the log", () => {
  const { out, screen } = fake({ verbose: true });
  screen.draw(["frame"]);
  screen.log(["a"]);
  screen.suspend();
  screen.resume();
  const n = out.length;
  screen.keep(["push? y"]);
  expect(out).toHaveLength(n);
  screen.log(["b"]);
  screen.finish(["done"]);
  const w = out.at(-1) ?? "";
  expect(w).toContain("a\npush? y\nb\ndone\n");
  expect(w.split("push? y")).toHaveLength(2);
});

test("keep is ignored inline, where nothing is replayed", () => {
  const { all, screen } = fake();
  screen.keep(["push? y"]);
  screen.finish(["done"]);
  expect(all()).not.toContain("push? y");
});

test("suspend clears the frame and shows the cursor, and resume hides it again", () => {
  const { out, screen } = fake();
  screen.draw(["a", "b"]);
  screen.suspend();
  // Inline, the question replaces the frame, so no stale frame stays in the scrollback.
  expect(out.at(-1)).toStartWith("\x1b[2A");
  expect(out.at(-1)).toContain("\x1b[?25h");
  expect(out.at(-1)).not.toContain("\x1b[?25l");
  // Nothing is drawn while the question waits for its answer.
  const n = out.length;
  screen.draw(["c"]);
  expect(out).toHaveLength(n);
  screen.resume();
  expect(out.at(-1)).toContain("\x1b[?25l");
  // The next frame goes below the answer.
  screen.draw(["d"]);
  expect(out.at(-1)).not.toMatch(/\x1b\[\d+A/);
  expect(out.at(-1)).toContain("d\n");
});

test("a verbose suspend parks the cursor under the log", () => {
  const { out, screen } = fake({ verbose: true });
  screen.draw(["1", "2"]);
  screen.log(["a"]);
  screen.suspend();
  expect(out.at(-1)).toContain("\x1b[4;1H");
  expect(out.at(-1)).toContain("\x1b[?25h");
  screen.log(["later"]);
  expect(out.at(-1)).not.toContain("later");
  screen.resume();
  expect(out.at(-1)).toContain("later");
  expect(out.at(-1)).toContain("\x1b[?25l");
});

test("finish leaves the card in the scrollback and restores the terminal", () => {
  const { all, screen } = fake();
  screen.draw(["running"]);
  screen.finish(["done"]);
  const text = all(),
    tail = text.slice(text.lastIndexOf("\x1b[1A"));
  expect(tail).toContain("\x1b[0J");
  expect(tail).toContain("done\n");
  expect(tail).toContain("\x1b[?25h");
  expect(tail).toContain("\x1b]9;4;0;\x07");
  expect(tail).toContain("\x1b[r");
  expect(tail.indexOf("\x1b[?25h")).toBeGreaterThan(tail.indexOf("done"));
  expect(text.endsWith(off)).toBe(true);
});

/** Whether `s` moves the cursor away from where the card ended: cursor
 * up or position, home, or a region reset not between save and restore. */
const moves = (s: string) =>
  /\x1b\[\d*[ABCDHf]|\x1b\[\d*;\d*[Hf]/.test(s) || /\x1b\[r/.test(s.replaceAll("\x1b7\x1b[r\x1b8", ""));

test("the cursor stays below the card after finish", () => {
  for (const verbose of [false, true]) {
    const { all, screen } = fake({ verbose });
    screen.draw(["running"]);
    screen.log(["a"]);
    screen.finish(["done"]);
    const text = all(),
      after = text.slice(text.lastIndexOf("done\n") + "done\n".length);
    expect(after).toBe(term.restore());
    expect(moves(after)).toBe(false);
  }
});

test("a verbose finish writes the whole log above the card", () => {
  const { all, out, screen } = fake({ verbose: true, rows: 6 });
  screen.draw(["frame"]);
  screen.log(Array.from({ length: 12 }, (_, i) => `log ${i}`));
  screen.finish(["done"]);
  const w = out.at(-1) ?? "";
  expect(w).toContain("\x1b[r\x1b[H\x1b[0J");
  expect(w).toContain(`${Array.from({ length: 12 }, (_, i) => `log ${i}`).join("\n")}\ndone\n`);
  expect(w).not.toContain("frame");
  expect(all().endsWith(term.restore())).toBe(true);
});

test("draws after finish write nothing", () => {
  const { out, screen } = fake();
  screen.finish(["done"]);
  const n = out.length;
  screen.draw(["again"]);
  screen.log(["x"]);
  screen.resume();
  expect(out).toHaveLength(n);
});

test("restore returns the reset without writing it", () => {
  const { out, screen } = fake();
  screen.draw(["a"]);
  const n = out.length;
  expect(screen.restore()).toBe(term.restore());
  expect(out).toHaveLength(n);
});

test("a verbose restore puts the cursor on the last row", () => {
  const { screen } = fake({ verbose: true });
  screen.draw(["a"]);
  expect(screen.restore()).toBe(`${term.restore()}\x1b[24;1H\n`);
});
