import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fileAccess from "./file_access";
import * as filePane from "./file_pane";
import { Source } from "./file_source";
import { Reader } from "./file_view";
import * as terminalInput from "./terminal_input";
import { Writer } from "./text";

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

test("opens editors at the line as each expects, through the shell as git runs them", async () => {
  const run = (editor: string, line: number | null) => filePane.editorCommand(editor, "/a.ts", line).slice(4);
  expect(run("nvim", 12)).toEqual(["+12", "/a.ts"]);
  expect(run("emacs -nw", 12)).toEqual(["+12", "/a.ts"]);
  expect(run("/usr/bin/code --wait", 12)).toEqual(["-g", "/a.ts:12"]);
  expect(run('"/Applications/Visual Studio Code.app/bin/code" --wait', 12)).toEqual(["-g", "/a.ts:12"]);
  expect(run("hx", 12)).toEqual(["/a.ts:12"]);
  expect(filePane.editorCommand("", "/a.ts", null)).toEqual(["/bin/sh", "-c", 'vi "$@"', "vi", "/a.ts"]);
  // A quoted path in the setting stays one argument.
  const argv = filePane.editorCommand(`printf '%s\\n' -u "/tmp/My Config/init.vim"`, "/a.ts", 12);
  const out = await new Response(Bun.spawn(argv, { stdout: "pipe" }).stdout).text();
  expect(out.split("\n")).toEqual(["-u", "/tmp/My Config/init.vim", "+12", "/a.ts", ""]);
});

test("reads keys and mouse reports from terminal input, waiting out a key a read cut short", () => {
  const parser = new terminalInput.Parser(),
    read = (data: string, now: number) => filePane.input(parser.feed(Buffer.from(data, "latin1"), now));
  expect(read("jk\x1b[B\x1b[6~G", 0)).toEqual([
    { key: "down" },
    { key: "up" },
    { key: "down" },
    { key: "page_down" },
    { key: "end" },
  ]);
  expect(read("\x1b[<64;5;7M\x1b[<0;1;3m", 0)).toEqual([
    { mouse: { button: 64, x: 4, y: 6, release: false } },
    { mouse: { button: 0, x: 0, y: 2, release: true } },
  ]);
  // An arrow split between reads moves rather than closing the pane.
  expect(read("\x1b", 1)).toEqual([]);
  expect(read("[", 2)).toEqual([]);
  expect(read("A", 3)).toEqual([{ key: "up" }]);
  // Escape alone closes it once nothing follows.
  expect(read("\x1b", 10)).toEqual([]);
  expect(filePane.input(parser.expire(10 + 49))).toEqual([]);
  expect(filePane.input(parser.expire(parser.due()))).toEqual([{ key: "quit" }]);
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
  expect(view.lineShown(8)).toBe(2);
});

test("the editor opens at the named line while it shows, and at the top line once scrolled away", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-pane-"));
  dirs.push(dir);
  const path = join(dir, "a.txt");
  writeFileSync(path, Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
  const source = await Source.open(path, { follow: false });
  opened.push(source);
  const view = new filePane.View(new Reader(source, 50), 50);
  view.draw(60, 12);
  expect(view.lineShown(12)).toBe(50);
  view.key("page_down", 12);
  view.key("page_down", 12);
  view.draw(60, 12);
  expect(view.lineShown(12)).toBe(view.reader.top + 1);
  expect(view.lineShown(12)).not.toBe(50);
});

test("frames what a viewer asks a pane's process, whole or in pieces, among keys", () => {
  const edit = filePane.editRequest(42);
  expect(filePane.requests(edit)).toEqual({ found: [{ edit: 42 }], other: "", rest: "" });
  expect(
    filePane.requests("j" + filePane.quiet_request + "k" + filePane.editRequest(null) + filePane.quit_request),
  ).toEqual({ found: ["quiet", { edit: null }, "quit"], other: "jk", rest: "" });
  // Keys pass, an arrow's Escape too; a lone Escape waits to see what follows.
  expect(filePane.requests("j\x1b[Bq")).toEqual({ found: [], other: "j\x1b[Bq", rest: "" });
  expect(filePane.requests("j\x1b")).toEqual({ found: [], other: "j", rest: "\x1b" });
  // A read can end at any byte, the first Escape too.
  for (let cut = 1; cut < edit.length; cut++) {
    const first = filePane.requests("j" + edit.slice(0, cut));
    expect(first.found).toEqual([]);
    expect(first.other).toBe("j");
    expect(filePane.requests(first.rest + edit.slice(cut))).toEqual({ found: [{ edit: 42 }], other: "", rest: "" });
  }
});

test("a viewer reads a pane's file itself and keeps its keys from the pane's process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-file-pane-"));
  dirs.push(dir);
  const path = join(dir, "app.ts");
  writeFileSync(path, Array.from({ length: 200 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n"));
  let woke!: () => void;
  const ready = new Promise<void>(resolve => (woke = resolve));
  const panes = new filePane.Panes(() => woke());
  const named = { path, line: 100, column: null };
  const told: number[] = [];
  panes.sync([{ id: 3, view: named }], fileAccess.here, id => told.push(id));
  const hosted = panes.get(3)!;
  // The same name keeps what's open, and its process is told once.
  panes.sync([{ id: 3, view: { ...named } }], fileAccess.here, id => told.push(id));
  expect(panes.get(3)).toBe(hosted);
  expect(told).toEqual([3]);
  await ready;
  opened.push(hosted.view!.reader.source);
  const text = () => {
    const w = new Writer();
    hosted.draw(w, 10, 5, 60, 20, null);
    return w.s.replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
  };
  expect(text()).toContain("const v100 = 100;");
  const top = hosted.view!.reader.top;
  expect(hosted.key("j", 20)).toBe("");
  expect(hosted.view!.reader.top).toBe(top + 1);
  hosted.mouse(65, 4, 4, false, 20);
  expect(hosted.view!.reader.top).toBe(top + 4);
  // A drag selects the text it crosses, without the line numbers, and copies it on release.
  text();
  const col = hosted.view!.textColumn,
    first = hosted.view!.reader.source.number(hosted.view!.reader.at(2, 18, true)!.row)!;
  expect(hosted.mouse(0, col + 6, 3, false, 20)).toBeNull();
  expect(hosted.mouse(32, col + 8, 4, false, 20)).toBeNull();
  expect(hosted.mouse(0, col + 8, 4, true, 20)).toBe(`v${first} = ${first};\nconst v${first + 1}`);
  // A click alone copies nothing, and Shift changes nothing.
  expect(hosted.mouse(4, col + 6, 3, false, 20)).toBeNull();
  expect(hosted.mouse(4, col + 6, 3, true, 20)).toBeNull();
  // A paste isn't keys. The editor and the end are the process's to do.
  expect(hosted.key("qqq", 20)).toBe("");
  expect(hosted.key("e", 20)).toBe(filePane.editRequest(hosted.view!.lineShown(20)));
  expect(hosted.key("q", 20)).toBe(filePane.quit_request);
  // A pane that names no file lets go of it.
  panes.sync([{ id: 3, view: null }], fileAccess.here);
  expect(panes.get(3)).toBeNull();
});
