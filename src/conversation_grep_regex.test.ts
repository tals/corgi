import { expect, test } from "bun:test";
import { compile, scan, type Query, type Row } from "./conversation_grep_regex";

async function rows(text: string, patterns: string[], options: Partial<Query> = {}) {
  const query = { patterns, flags: [], before: 0, after: 0, maxCount: 100, ...options },
    found: Row<{ text: string; number: number }>[] = [];
  const lines = text
    .replace(/\n$/, "")
    .split("\n")
    .map((text, i) => ({ text, number: i + 1 }));
  await scan(query, compile(query), lines, async row => {
    found.push(row);
  });
  return found.map(r => [
    r.type === "match" ? ":" : "-",
    r.line.number,
    r.line.text,
    ...r.submatches.map(m => [m.start, m.end]),
  ]);
}
const lines = async (text: string, patterns: string[], options: Partial<Query> = {}) =>
  (await rows(text, patterns, options)).map(r => r[1]);

test("case, literal, word and line flags behave as in rg", async () => {
  const text = "Merge here\nmerge\nsubmerged\ncafé\ncafés\nC:\\tmp\\work\na.b\n";
  expect(await lines(text, ["merge"])).toEqual([2, 3]);
  expect(await lines(text, ["merge"], { flags: ["-S"] })).toEqual([1, 2, 3]);
  expect(await lines(text, ["Merge"], { flags: ["-S"] })).toEqual([1]);
  expect(await lines(text, ["Merge"], { flags: ["-i", "-s"] })).toEqual([1]);
  expect(await lines(text, ["merge"], { flags: ["-i", "-w"] })).toEqual([1, 2]);
  expect(await lines(text, ["café"], { flags: ["-w"] })).toEqual([4]);
  expect(await lines(text, ["merge", "Merge here"], { flags: ["-x"] })).toEqual([1, 2]);
  expect(await lines(text, ["C:\\tmp\\work", "a.b"], { flags: ["-F"] })).toEqual([6, 7]);
  expect(await lines(text, ["\\p{Lu}"])).toEqual([1, 6]);
});

test("slashes and backslashes need no help, other needless escapes say what to write", async () => {
  expect(await lines("src/app\na\\b\n", ["src\\/app", "a\\\\b"])).toEqual([1, 2]);
  await expect(lines("foo-bar\n", ["foo\\-bar"])).rejects.toThrow(/JavaScript regex: escape only regex syntax/);
});

test("matches stay within a line and report every UTF-8 byte range", async () => {
  expect(await rows("é x é\nend", ["é"])).toEqual([[":", 1, "é x é", [0, 2], [5, 7]]]);
  expect(await rows("a\nb\nlast b", ["a\\sb", "b$"])).toEqual([
    [":", 2, "b", [0, 1]],
    [":", 3, "last b", [5, 6]],
  ]);
});

test("context lines appear once around matches, and the count keeps trailing context", async () => {
  const text = ["one", "hit two", "three", "four", "hit five", "six", "seven", "hit eight", "nine"].join("\n") + "\n";
  expect((await rows(text, ["hit"], { before: 1, after: 1 })).map(r => `${r[0]}${r[1]}`)).toEqual([
    "-1",
    ":2",
    "-3",
    "-4",
    ":5",
    "-6",
    "-7",
    ":8",
    "-9",
  ]);
  expect((await rows(text, ["hit"], { before: 2, after: 2, maxCount: 1 })).map(r => `${r[0]}${r[1]}`)).toEqual([
    "-1",
    ":2",
    "-3",
    "-4",
  ]);
});
