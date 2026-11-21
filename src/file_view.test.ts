import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Canvas } from "./canvas";
import { Source } from "./file_source";
import { Reader } from "./file_view";

const dirs: string[] = [];
const opened: Source[] = [];
async function reader(name: string, text: string, line: number | null = null): Promise<Reader> {
  const dir = mkdtempSync(join(tmpdir(), "corgi-view-"));
  dirs.push(dir);
  writeFileSync(join(dir, name), text);
  const source = await Source.open(join(dir, name), { follow: false });
  opened.push(source);
  return new Reader(source, line);
}
afterEach(async () => {
  for (const source of opened.splice(0)) await source.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const code = [
  "import x from 'y';",
  "",
  "export function outer() {",
  "  const a = 1;",
  "  if (a) {",
  "    return a;",
  "  }",
  "}",
  "",
  "export class Thing {",
  "  method() {",
  "    work();",
  "    more();",
  "  }",
  "}",
].join("\n");
const rows = (r: Reader, w: number, h: number) => {
  const c = new Canvas(0, 0, w, h);
  r.draw(c, 0, 0, w, h, { bg: null, context: true, folds: true });
  return c.cells.map(row =>
    row
      .map(cell => cell.ch)
      .join("")
      .trimEnd(),
  );
};

test("centers the line the text named", async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");
  const r = await reader("a.ts", lines, 50);
  r.sync(11);
  expect(r.target).toBe(49);
  expect(r.top).toBe(44);
  expect(rows(r, 30, 11)[5]).toContain("50 const v50");
});

test("pins the lines that open the blocks above the top row", async () => {
  const r = await reader("b.ts", code);
  expect(r.context(5, 2)).toEqual([2, 4]);
  expect(r.context(12, 2)).toEqual([9, 10]);
  expect(r.context(12, 1)).toEqual([10]);
  expect(r.context(8, 2)).toEqual([]);
  // Pins speak for the first row they leave showing, here the closing brace inside outer().
  r.sync(10);
  r.top = 5;
  expect(rows(r, 40, 10).slice(0, 2)).toEqual(["    3 export function outer() {", "    7   }"]);
  const deep = await reader(
    "d.ts",
    ["function f() {", "  if (x) {", "    one();", "    two();", "    three();", "    four();", "  }", "}"].join("\n"),
  );
  deep.sync(10);
  deep.top = 2;
  const shown = rows(deep, 40, 10);
  expect(shown[0]).toContain("1 function f() {");
  expect(shown[1]).toContain("2   if (x) {");
  expect(shown[2]).toContain("5     three();");
});

test("folds by indent, taking in the bracket that closes the block", async () => {
  const r = await reader("c.ts", code);
  expect([...r.foldEnds()].sort((a, b) => a[0] - b[0])).toEqual([
    [2, 7],
    [4, 6],
    [9, 14],
    [10, 13],
  ]);
  r.toggleFold(3);
  expect(r.folded).toEqual(new Set([2]));
  r.sync(20);
  const shown = rows(r, 60, 20);
  expect(shown[2]).toBe("▸   3 export function outer() {  ⋯ 5 lines  }");
  expect(shown[3]).toContain("9");
  r.toggleAll();
  expect(r.folded).toEqual(new Set());
  r.toggleAll();
  expect(r.folded).toEqual(new Set([2, 9]));
});

test("follows a growing log and keeps its place once scrolled back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-view-"));
  dirs.push(dir);
  const path = join(dir, "x.log");
  writeFileSync(path, Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") + "\n");
  const source = await Source.open(path, { follow: false });
  opened.push(source);
  const r = new Reader(source);
  r.sync(10);
  expect([r.following, r.top]).toEqual([true, 20]);
  appendFileSync(path, "row 30\nrow 31\n");
  await source.refresh();
  r.sync(10);
  expect(r.top).toBe(22);
  r.scroll(-5, 10);
  expect(r.following).toBe(false);
  appendFileSync(path, "row 32\n");
  await source.refresh();
  r.sync(10);
  expect([r.top, r.fresh]).toEqual([17, 1]);
  r.scroll(100, 10);
  expect([r.following, r.fresh]).toEqual([true, 0]);
});

test("following from the middle of a large log goes to its end, and home goes to its first line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-view-"));
  dirs.push(dir);
  const path = join(dir, "big.log");
  writeFileSync(path, Array.from({ length: 300_000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const source = await Source.open(path, { follow: false, line: 150_000 });
  opened.push(source);
  const r = new Reader(source, 150_000);
  r.sync(10);
  expect(r.source.line(r.target!)).toBe("line 150000");
  expect(r.following).toBe(false);
  r.follow(true);
  await r.source.settled();
  await Reflect.get(r.source, "chain");
  r.sync(10);
  expect(r.following).toBe(true);
  expect(r.source.line(r.shownRows()[r.top + 9].row)).toBe("line 300000");
  r.home();
  await Reflect.get(r.source, "chain");
  r.sync(10);
  expect([r.following, r.top]).toEqual([false, 0]);
  expect(r.source.number(0)).toBe(1);
  expect(r.source.line(0)).toBe("line 1");
});

test("of a jump to the start and one to the end asked for at once, the later wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-view-"));
  dirs.push(dir);
  const path = join(dir, "jumps.log");
  writeFileSync(path, Array.from({ length: 300_000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const settle = async (r: Reader) => {
    await Reflect.get(r.source, "chain");
    r.sync(10);
  };
  // From the end: g then G follows the end.
  const end = await Source.open(path, { follow: false });
  opened.push(end);
  const a = new Reader(end);
  a.sync(10);
  a.home();
  a.follow(true);
  await settle(a);
  expect([a.following, end.atEnd]).toEqual([true, true]);
  expect(end.line(a.shownRows()[a.top + 9].row)).toBe("line 300000");
  // From the middle: G then g stays at the start.
  const mid = await Source.open(path, { follow: false, line: 150_000 });
  opened.push(mid);
  const b = new Reader(mid, 150_000);
  b.sync(10);
  b.follow(true);
  b.home();
  await settle(b);
  expect([b.following, b.top, mid.start]).toEqual([false, 0, 0]);
  expect(mid.line(0)).toBe("line 1");
});

test("a pinned line is what a click on it means", async () => {
  const r = await reader("a.ts", code);
  r.top = 3;
  const pinned = r.pinned(6, true);
  expect(pinned).toEqual([2]);
  expect(r.at(0, 6, true)).toEqual({ row: 2, index: null });
  expect(r.at(1, 6, true)).toEqual({ row: 4, index: 4 });
  expect(r.at(1, 6, false)).toEqual({ row: 4, index: 4 });
  expect(r.at(0, 6, false)).toEqual({ row: 3, index: 3 });
});

test("cuts long lines and expands tabs", async () => {
  const r = await reader("d.txt", "\tindented\n" + "y".repeat(50));
  r.sync(2);
  const c = new Canvas(0, 0, 20, 2);
  r.draw(c, 0, 0, 20, 2, { bg: null });
  const shown = c.cells.map(row => row.map(cell => cell.ch).join(""));
  expect(shown[0]).toBe("  1     indented    ");
  expect(shown[1]).toBe("  2 " + "y".repeat(15) + "›");
});

test("scrolled right, a wide character cut in half shows its right half blank", async () => {
  const r = await reader("w.txt", "a界bc");
  r.sync(1);
  const c = new Canvas(0, 0, 12, 1);
  r.draw(c, 0, 0, 12, 1, { bg: null, shift: 2 });
  expect(c.cells[0].map(cell => cell.ch).join("")).toBe("  1  bc     ");
});

test("a wide character the cut marker would halve gives way whole", async () => {
  const r = await reader("w.txt", "abc界def");
  r.sync(1);
  const c = new Canvas(0, 0, 9, 1);
  r.draw(c, 0, 0, 9, 1, { bg: null });
  // "  1 " then five columns: a, b, c, then 界's two, which the marker cuts.
  expect(c.cells[0].map(cell => cell.ch)).toEqual([" ", " ", "1", " ", "a", "b", "c", " ", "›"]);
});
