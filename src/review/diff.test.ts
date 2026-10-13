import { expect, test } from "bun:test";
import * as diff from "./diff";

const patch = (lines: string[], header = "@@ -1,12 +1,13 @@") =>
  ["diff --git a/f.ts b/f.ts", "index 1..2 100644", "--- a/f.ts", "+++ b/f.ts", header, ...lines, ""].join("\n");

test("parses both sides and numbers each row", () => {
  const d = diff.parse(patch([" a", "-b", "+B", "+c", " d"], "@@ -1,3 +1,4 @@")) as diff.FileDiff;
  expect(d.old).toEqual(["a", "b", "d"]);
  expect(d.new).toEqual(["a", "B", "c", "d"]);
  expect(d.rows.map(r => [r.kind, r.old_no, r.new_no])).toEqual([
    ["context", 1, 1],
    ["deletion", 2, 0],
    ["insertion", 0, 2],
    ["insertion", 0, 3],
    ["context", 3, 4],
  ]);
  expect([d.adds, d.dels]).toEqual([2, 1]);
});

test("a new file starts its numbering at one", () => {
  const d = diff.parse(patch(["+x", "+y"], "@@ -0,0 +1,2 @@")) as diff.FileDiff;
  expect(d.rows.map(r => r.new_no)).toEqual([1, 2]);
  expect(d.old).toEqual([]);
});

test("git's binary notice and missing newline markers", () => {
  expect(diff.parse("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n")).toBe("binary");
  const d = diff.parse(patch(["-a", "\\ No newline at end of file", "+a", "+b"], "@@ -1 +1,2 @@")) as diff.FileDiff;
  expect(d.old).toEqual(["a"]);
  expect(d.new).toEqual(["a", "b"]);
});

test("long unchanged runs fold, keeping three lines beside each change", () => {
  const lines = Array.from({ length: 10 }, (_, i) => ` ${i}`);
  const d = diff.parse(patch([...lines, "-x", "+y", ...lines])) as diff.FileDiff;
  const kinds = d.units.map(u => (u.kind === "fold" ? `fold ${u.end - u.start}` : d.rows[u.row].kind[0]));
  expect(kinds).toEqual(["fold 7", "c", "c", "c", "d", "i", "c", "c", "c", "fold 7"]);
  // A fold opens by its first hidden line's number, which survives rebuilds.
  const anchor = diff.foldAnchor(d, d.units[0]);
  expect(anchor).toBe(1);
  expect(diff.shown(d, new Set([anchor])).length).toBe(d.units.length - 1 + 7);
});

test("a run that would hide a single line stays open", () => {
  const d = diff.parse(patch(["-a", "+b", " 1", " 2", " 3", " 4", " 5", " 6", " 7", "-c", "+d"])) as diff.FileDiff;
  expect(d.units.every(u => u.kind === "row")).toBe(true);
});

test("hunks start where a change follows unchanged lines", () => {
  const d = diff.parse(patch(["-a", "+b", " 1", "-c", "-e", "+d"])) as diff.FileDiff;
  expect(diff.hunkStarts(d, d.units)).toEqual([0, 3]);
});

test("an edited line pairs with its new self and marks the changed words", () => {
  const d = diff.parse(
    patch([
      "-    drawRow(w, row, width);",
      "-    w.write(clearLine(width));",
      "+    const line = new Writer();",
      "+    drawRow(line, row, width);",
    ]),
  ) as diff.FileDiff;
  expect(d.emphasis(0)).toEqual([[12, 13]]);
  expect(d.emphasis(3)).toEqual([[12, 16]]);
  // Unpaired lines keep only their row color.
  expect(d.emphasis(1)).toBeNull();
  expect(d.emphasis(2)).toBeNull();
});

test("a rewritten line stays unpaired below the similarity bar", () => {
  const found = diff.wordDiff("return gap > 0 ? line : line;", "const width = area.w - 2;")!;
  expect(found.similarity).toBeLessThan(diff.min_similarity);
});

test("changed words join across spaces but not across other text", () => {
  const found = diff.wordDiff("a b c d", "a x y d")!;
  expect(found.new).toEqual([[2, 5]]);
});
