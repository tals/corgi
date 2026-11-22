import { expect, test } from "bun:test";
import * as fuzzy from "./fuzzy";

const score = (query: string, text: string) => fuzzy.score(fuzzy.pattern(query)!, new fuzzy.Candidate(text));
/** `texts` best first, as the browser ranks them. */
const ranked = (query: string, texts: string[]) =>
  texts
    .map((text, i) => ({ text, i, s: score(query, text) }))
    .filter(m => m.s !== null)
    .sort((a, b) => b.s! - a.s! || a.text.length - b.text.length || a.i - b.i)
    .map(m => m.text);
const lit = (query: string, text: string) => fuzzy.positions(fuzzy.pattern(query)!, text);

test("matches a query's characters in order, anywhere", () => {
  expect(score("abc", "a/b/c.ts")).not.toBeNull();
  expect(score("acb", "a/b/c.ts")).toBeNull();
  expect(score("x", "a/b/c.ts")).toBeNull();
  expect(fuzzy.pattern("")).toBeNull();
  expect(fuzzy.pattern("   ")).toBeNull();
});

test("ignores case until the query has a capital", () => {
  expect(score("readme", "README.md")).not.toBeNull();
  expect(score("ReadMe", "README.md")).toBeNull();
  expect(score("README", "README.md")).not.toBeNull();
  expect(score("Rm", "src/Readme.md")).not.toBeNull();
  expect(score("RM", "src/Readme.md")).toBeNull();
});

test("each word a space separates matches, in any order", () => {
  expect(score("test app", "src/app.test.ts")).not.toBeNull();
  expect(score("app test", "src/app.test.ts")).not.toBeNull();
  expect(score("app zzz", "src/app.test.ts")).toBeNull();
  expect(lit("ts app", "src/app.ts")).toEqual([4, 5, 6, 8, 9]);
});

test("ranks starts of path parts and words, camelCase humps, runs and the name first", () => {
  // A part's start beats the middle of a word.
  expect(ranked("fb", ["fabric.ts", "foo/bar.ts"])).toEqual(["foo/bar.ts", "fabric.ts"]);
  // A run beats the same letters spread out.
  expect(ranked("app", ["a/p/p.ts", "src/app.ts"])).toEqual(["src/app.ts", "a/p/p.ts"]);
  // A camelCase hump counts as a word's start.
  expect(ranked("fv", ["src/fileview.ts", "src/fileView.ts"])).toEqual(["src/fileView.ts", "src/fileview.ts"]);
  // In the name beats in a folder of the same name.
  expect(ranked("main", ["main/util.ts", "src/main.ts"])).toEqual(["src/main.ts", "main/util.ts"]);
  // After a word boundary: "_" and "-" start words too.
  expect(ranked("dw", ["src/drawer.ts", "src/dir_walk.ts"])).toEqual(["src/dir_walk.ts", "src/drawer.ts"]);
  // Equal scores go to the shorter path.
  expect(ranked("ab", ["x/ab/c.ts", "x/ab.ts"])[0]).toBe("x/ab.ts");
});

test("finds the characters it matched, where the score is best", () => {
  expect(lit("fb", "foo/bar.ts")).toEqual([0, 4]);
  // The run in the name, not the scattered letters before it.
  expect(lit("app", "a/p/p/app.ts")).toEqual([6, 7, 8]);
  expect(lit("dwt", "src/dir_walk.test.ts")).toEqual([4, 8, 13]);
  expect(lit("zz", "abc")).toEqual([]);
});

test("a long gap wears the score down but still matches", () => {
  const far = "a" + "x".repeat(200) + "b";
  expect(score("ab", far)).not.toBeNull();
  expect(score("ab", "ab")!).toBeGreaterThan(score("ab", far)!);
});

test("non-ASCII names fold case unit for unit", () => {
  expect(score("é", "docs/Été.md")).not.toBeNull();
  expect(lit("ét", "docs/Été.md")).toEqual([5, 6]);
  expect(fuzzy.lower("İx")).toHaveLength(2);
});
