import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as filePane from "./file_pane";
import { Source } from "./file_source";
import { Reader } from "./file_view";

const dirs: string[] = [];
const opened: Source[] = [];
afterEach(async () => {
  for (const source of opened.splice(0)) await source.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("takes a path and the line and column to open at", () => {
  expect(filePane.parseArgs(["/a/b.ts"])).toEqual({ path: "/a/b.ts", line: null, column: null });
  expect(filePane.parseArgs(["/a/b.ts", "--line", "12", "--column", "3"])).toEqual({
    path: "/a/b.ts",
    line: 12,
    column: 3,
  });
  expect(filePane.parseArgs([])).toBeNull();
  expect(filePane.parseArgs(["/a", "--line", "0"])).toBeNull();
  expect(filePane.parseArgs(["/a", "/b"])).toBeNull();
});

test("opens editors at the line as each expects", () => {
  expect(filePane.editorCommand("nvim", "/a.ts", 12)).toEqual(["nvim", "+12", "/a.ts"]);
  expect(filePane.editorCommand("emacs -nw", "/a.ts", 12)).toEqual(["emacs", "-nw", "+12", "/a.ts"]);
  expect(filePane.editorCommand("/usr/bin/code --wait", "/a.ts", 12)).toEqual([
    "/usr/bin/code",
    "--wait",
    "-g",
    "/a.ts:12",
  ]);
  expect(filePane.editorCommand("hx", "/a.ts", 12)).toEqual(["hx", "/a.ts:12"]);
  expect(filePane.editorCommand("", "/a.ts", null)).toEqual(["vi", "/a.ts"]);
});

test("reads keys and mouse reports from terminal input", () => {
  expect(filePane.input("jk\x1b[B\x1b[6~G")).toEqual([
    { key: "down" },
    { key: "up" },
    { key: "down" },
    { key: "page_down" },
    { key: "end" },
  ]);
  expect(filePane.input("\x1b[<64;5;7M\x1b[<0;1;3m")).toEqual([
    { mouse: { button: 64, x: 4, y: 6, release: false } },
    { mouse: { button: 0, x: 0, y: 2, release: true } },
  ]);
  expect(filePane.input("\x1b")).toEqual([{ key: "quit" }]);
});

test("draws a header, the file and its keys, and folds from the gutter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-pane-"));
  dirs.push(dir);
  const path = join(dir, "a.ts");
  writeFileSync(path, "function f() {\n  one();\n  two();\n}\nf();\n");
  const source = await Source.open(path, { follow: false });
  opened.push(source);
  const view = new filePane.View(new Reader(source, 2), 2);
  const plain = (s: string) => s.replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
  const frame = plain(view.draw(60, 8));
  expect(frame).toContain("a.ts");
  expect(frame).toContain("5 lines");
  expect(frame).toContain("one();");
  expect(frame).toContain("q close");
  view.mouse(0, 0, 1, false, 8);
  expect(view.reader.folded).toEqual(new Set([0]));
  expect(plain(view.draw(60, 8))).toContain("⋯ 3 lines");
  expect(view.lineShown()).toBe(2);
});
