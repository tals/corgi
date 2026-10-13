import { expect, test } from "bun:test";
import * as diff from "./diff";
import * as notes from "./notes";

const d = diff.parse(["@@ -1,3 +1,3 @@", " keep", "-old line", "+new line", " tail", ""].join("\n")) as diff.FileDiff;

test("a note anchors to new-side lines, or to removed ones alone", () => {
  expect(notes.anchor(d, d.rows.slice(0, 3))).toEqual({
    side: "new",
    start: 1,
    end: 2,
    snippet: " keep\n-old line\n+new line",
  });
  expect(notes.anchor(d, [d.rows[1]])).toEqual({ side: "old", start: 2, end: 2, snippet: "-old line" });
});

test("send text sorts by file and line and keeps blocks apart", () => {
  const base = { rev: { kind: "worktree" } as notes.Rev, side: "new" as const, snippet: "+x" };
  const text = notes.format([
    { ...base, id: 1, path: "b.ts", start: 4, end: 4, text: "second\n\nstill second  " },
    { ...base, id: 2, path: "a.ts", start: 9, end: 12, text: "first" },
    {
      ...base,
      id: 3,
      path: "a.ts",
      start: 2,
      end: 2,
      side: "old",
      text: "gone?",
      rev: { kind: "commit", hash: "abcdef0123" },
    },
  ]);
  expect(text).toBe(
    "a.ts:2 (removed) in abcdef0\n+x\ngone?\n\na.ts:9-12\n+x\nfirst\n\nb.ts:4\n+x\nsecond\nstill second",
  );
});

test("a note covers the rows on its side and range", () => {
  const note: notes.Note = {
    id: 1,
    path: "f",
    rev: { kind: "worktree" },
    side: "new",
    start: 2,
    end: 2,
    snippet: "",
    text: "",
  };
  expect(d.rows.map(r => notes.covers(note, r))).toEqual([false, false, true, false]);
});
