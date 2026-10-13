import { expect, test } from "bun:test";
import * as syntax from "./syntax";

const kinds = (lang: string, line: string) =>
  syntax
    .lexLine(lang, line, { block: false, string: null, fence: false })
    .spans.map(([s, e, k]) => `${k}:${line.slice(s, e)}`);

test("languages come from the file name", () => {
  expect(syntax.language("src/review/panel.ts")).toBe("typescript");
  expect(syntax.language("native/zig/build.zig")).toBe("zig");
  expect(syntax.language("bun.lock")).toBe("json");
  expect(syntax.language("LICENSE")).toBeNull();
});

test("typescript keywords, types, calls, strings and comments", () => {
  expect(kinds("typescript", 'export function padTo(line: string): Row { return "x"; } // pad')).toEqual([
    "keyword:export",
    "keyword:function",
    "function:padTo",
    "punctuation:(",
    "punctuation::",
    "type:string",
    "punctuation:):",
    "type:Row",
    "punctuation:{",
    "keyword:return",
    'string:"x"',
    "punctuation:;",
    "punctuation:}",
    "comment:// pad",
  ]);
});

test("zig builtins and line strings", () => {
  expect(kinds("zig", 'const std = @import("std");')).toEqual([
    "keyword:const",
    "punctuation:=",
    "function:@import",
    "punctuation:(",
    'string:"std"',
    "punctuation:);",
  ]);
  expect(kinds("zig", "    \\\\ raw text")).toEqual(["string:\\\\ raw text"]);
});

test("json keys read as properties", () => {
  expect(kinds("json", '  "name": "corgi", "n": 3')).toEqual([
    'property:"name"',
    "punctuation::",
    'string:"corgi"',
    "punctuation:,",
    'property:"n"',
    "punctuation::",
    "number:3",
  ]);
});

test("block comments and template strings carry across lines", () => {
  const lines = ["/* one", "two */ const x = `a", "b` + 1"];
  const h = new syntax.Highlighter("typescript", lines);
  expect(h.spans(1)[0]).toEqual([0, 6, "comment"]);
  expect(h.spans(2)[0]).toEqual([0, 2, "string"]);
});

test("a chunk deep in a file starts from the right state", () => {
  const lines = ["/*", ...Array.from({ length: 450 }, () => "inside"), "*/ const y = 1;"];
  const h = new syntax.Highlighter("typescript", lines);
  expect(h.spans(451)[0]).toEqual([0, 2, "comment"]);
  expect(h.spans(300)).toEqual([[0, 6, "comment"]]);
});

test("markdown headings, fences and inline code", () => {
  const h = new syntax.Highlighter("markdown", ["# Title", "Use `bun test`.", "```", "code", "```", "- item"]);
  expect(h.spans(0)).toEqual([[0, 7, "keyword"]]);
  expect(h.spans(1)).toEqual([[4, 14, "string"]]);
  expect(h.spans(3)).toEqual([[0, 4, "string"]]);
  expect(h.spans(5)).toEqual([[0, 2, "punctuation"]]);
});

test("colors stop at the line cap", () => {
  const long = "x".repeat(syntax.max_line + 50) + ' "late"';
  expect(kinds("typescript", long)).toEqual([]);
});
