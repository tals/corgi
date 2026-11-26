import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dirBrowser from "./dir_browser";
import * as dirWalk from "./dir_walk";
import * as fileAccess from "./file_access";
import { Rect } from "./layout";
import { Writer } from "./text";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-browse-")));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith("/")) mkdirSync(join(dir, path), { recursive: true });
    else {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }
  return dir;
}
/** This computer's files, with a walk the test feeds by hand. */
function fed() {
  let sink: ((batch: dirWalk.Entry[], progress: dirWalk.Progress) => void) | null = null,
    finish: ((p: dirWalk.Progress) => void) | null = null;
  const progress = dirWalk.started();
  const walks: { root: string; signal: AbortSignal }[] = [];
  const files: fileAccess.Files = {
    ...fileAccess.here,
    walk: (root, s, signal) => {
      walks.push({ root, signal });
      sink = s;
      return new Promise(resolve => (finish = resolve));
    },
  };
  return {
    files,
    walks,
    send(paths: string[], done = false) {
      progress.mode = "git";
      progress.scanned += paths.length;
      progress.done = done;
      const batch = paths.map(path => ({ path: path.replace(/\/$/, ""), directory: path.endsWith("/") }));
      sink!(batch, { ...progress });
      if (done) finish!({ ...progress });
    },
  };
}
/** Lets the matcher score everything the walk has sent. */
async function settle(b: dirBrowser.Browser): Promise<void> {
  for (let i = 0; i < 1000 && b.search?.scoring; i++) await new Promise(resolve => setTimeout(resolve, 1));
}
const type = (b: dirBrowser.Browser, text: string) => {
  for (const byte of Buffer.from(text)) b.typeByte(byte);
};
const paths = (b: dirBrowser.Browser) => Array.from({ length: b.count() }, (_, i) => b.row(i)!.path);
function shown(b: dirBrowser.Browser, pinned: boolean, now = 0): string {
  const w = new Writer();
  dirBrowser.draw(w, new Rect(0, 0, 60, dirBrowser.rows + 4), b, pinned, null, now);
  return w.s.replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
}

test("lists a folder, folders first and in natural order, with its files' sizes", async () => {
  const dir = folder({ "src/": "", "docs/": "", "file10.txt": "x".repeat(3000), "file2.txt": "", ".env": "" });
  const b = new dirBrowser.Browser(dir, () => {});
  await b.listed;
  expect(b.listing).toEqual([
    { path: "docs", directory: true, size: null },
    { path: "src", directory: true, size: null },
    { path: ".env", directory: false, size: 0 },
    { path: "file2.txt", directory: false, size: 0 },
    { path: "file10.txt", directory: false, size: 3000 },
  ]);
  const text = shown(b, false);
  expect(text).toContain("2 folders · 3 files");
  expect(text).toContain("docs/");
  expect(text).toContain("3 KB");
  expect(text).toContain("click to browse");
  // Read-only until pinned: no selection marker.
  expect(text).not.toContain("›");
  expect(shown(b, true)).toContain("›");
  b.close();
});

test("a query searches everything below as the walk streams in, ranking again and keeping the selection", async () => {
  const dir = folder({ "src/": "" });
  const walk = fed();
  let woke = 0;
  const b = new dirBrowser.Browser(dir, () => woke++, walk.files);
  await b.listed;
  // An empty query needs no walk.
  expect(walk.walks).toHaveLength(0);
  type(b, "app");
  expect(walk.walks).toEqual([{ root: dir, signal: expect.anything() }]);
  walk.send(["src/", "src/a/p/p.ts", "lib/", "lib/zz.ts"]);
  await settle(b);
  expect(paths(b)).toEqual(["src/a/p/p.ts"]);
  let text = shown(b, true, 0);
  expect(text).toContain("git · ");
  expect(text).toContain("⠋ 1/4");
  // The user moves to it; a better match arriving ranks above it, and it stays selected.
  b.move(1);
  expect(b.index()).toBe(0);
  expect(b.chosen).toBe(true);
  walk.send(["src/app.ts", "docs/app.md"], true);
  await settle(b);
  expect(paths(b)).toEqual(["src/app.ts", "docs/app.md", "src/a/p/p.ts"]);
  expect(b.row(b.index())!.path).toBe("src/a/p/p.ts");
  text = shown(b, true);
  expect(text).toContain("3/6");
  expect(text).not.toMatch(/[⠋⠙⠹]/);
  // Typing again starts from the best match; growing the query narrows the last matches.
  type(b, ".m");
  await settle(b);
  expect(paths(b)).toEqual(["docs/app.md"]);
  expect(b.index()).toBe(0);
  expect(b.chosen).toBe(false);
  // Deleting goes back to everything, without walking again.
  b.typeByte(127);
  b.typeByte(127);
  await settle(b);
  expect(paths(b)).toHaveLength(3);
  expect(walk.walks).toHaveLength(1);
  // An empty query lists the folder again.
  for (let i = 0; i < 3; i++) b.typeByte(127);
  expect(b.searching).toBe(false);
  expect(paths(b)).toEqual(["src"]);
  expect(woke).toBeGreaterThan(0);
  b.close();
  expect(walk.walks[0].signal.aborted).toBe(true);
});

test("a chosen match that better ones push down stays in view, and the wheel still scrolls away from it", async () => {
  const dir = folder({ "src/": "" });
  const walk = fed();
  const b = new dirBrowser.Browser(dir, () => {}, walk.files);
  await b.listed;
  type(b, "app");
  walk.send(["src/a/p/p.ts"]);
  await settle(b);
  b.move(1);
  walk.send(
    Array.from({ length: 15 }, (_, i) => `app${i}.ts`),
    true,
  );
  await settle(b);
  expect(b.index()).toBe(15);
  expect(shown(b, true)).toContain("src/a/p/p.ts");
  expect(b.top).toBe(15 - dirBrowser.rows + 1);
  b.wheel(true);
  expect(shown(b, true)).not.toContain("src/a/p/p.ts");
  expect(b.top).toBe(15 - dirBrowser.rows + 1 - dirBrowser.wheel_rows);
  b.close();
});

test("a walk's cap shows as a mark on its count and a note", async () => {
  const dir = folder({});
  const walk = fed();
  const b = new dirBrowser.Browser(dir, () => {}, walk.files);
  await b.listed;
  type(b, "a");
  walk.send(["a.ts"]);
  await settle(b);
  b.search!.progress = { ...b.search!.progress, done: true, capped: "entries", scanned: 1 };
  const text = shown(b, true);
  expect(text).toContain("1/1");
  expect(text).toContain("+");
  expect(text).toContain("stopped at 1 entries");
  b.close();
});

test("Enter goes into a folder or opens a file; Backspace on an empty query goes up to the folder it left", async () => {
  const dir = folder({ "src/app.ts": "x", "src/lib/util.ts": "", "README.md": "" });
  const b = new dirBrowser.Browser(dir, () => {});
  await b.listed;
  expect(paths(b)).toEqual(["src", "README.md"]);
  expect(await b.choose()).toBeNull();
  expect(b.root).toBe(join(dir, "src"));
  await b.listed;
  expect(paths(b)).toEqual(["lib", "app.ts"]);
  b.move(1);
  expect(await b.choose()).toEqual({ file: join(dir, "src", "app.ts") });
  b.parent();
  await b.listed;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(b.root).toBe(dir);
  expect(b.row(b.index())!.path).toBe("src");
  // A search's folder opens as a folder.
  type(b, "lib");
  await b.search!.walked;
  await settle(b);
  expect(paths(b)[0]).toBe("src/lib");
  expect(await b.choose()).toBeNull();
  expect(b.root).toBe(join(dir, "src", "lib"));
  expect(b.text).toBe("");
  b.close();
});

test("the query edits as a text box does, takes any character, and the wheel scrolls the list", async () => {
  const dir = folder(
    Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, "0")}.txt`, ""])),
  );
  const walk = fed();
  const b = new dirBrowser.Browser(dir, () => {}, walk.files);
  await b.listed;
  type(b, "née");
  expect(b.text).toBe("née");
  expect(b.editKey("left")).toBe(true);
  b.typeByte(120);
  expect(b.text).toBe("néxe");
  b.typeByte(21);
  expect(b.text).toBe("e");
  expect(b.editKey("up")).toBe(false);
  b.typeByte(127);
  expect(b.text).toBe("e");
  b.typeByte(1);
  b.typeByte(127);
  expect(b.text).toBe("e");
  expect(b.typeByte(4)).toBe(false);
  b.typeByte(5);
  b.typeByte(127);
  expect(b.text).toBe("");
  b.wheel(false);
  expect(b.top).toBe(dirBrowser.wheel_rows);
  b.wheel(true);
  b.wheel(true);
  expect(b.top).toBe(0);
  for (let i = 0; i < 20; i++) b.move(1);
  expect(b.index()).toBe(20);
  expect(b.top).toBe(20 - dirBrowser.rows + 1);
  b.close();
});

test("a slow answer to Enter is dropped once the card has gone elsewhere", async () => {
  const dir = folder({ "src/app.ts": "x" });
  const answers: ((info: fileAccess.Info) => void)[] = [];
  // A slow link: each check of what an entry is waits for the test.
  const files: fileAccess.Files = { ...fileAccess.here, find: () => new Promise(resolve => answers.push(resolve)) };
  const b = new dirBrowser.Browser(join(dir, "src"), () => {}, files);
  await b.listed;
  b.select(b.find("app.ts"));
  // Enter on the file, then Backspace before the answer comes.
  const file = b.choose();
  b.parent();
  answers[0]({ path: join(dir, "src", "app.ts"), size: 1, mtime: 0, id: "1:1", directory: false });
  expect(await file).toBeNull();
  expect(b.root).toBe(dir);
  // Nor does a folder that listed as a file, as a Git submodule does, pull
  // the card back into the folder it left.
  const back = new dirBrowser.Browser(join(dir, "src"), () => {}, files);
  await back.listed;
  back.select(back.find("app.ts"));
  const folderish = back.choose();
  back.parent();
  answers[1]({ path: join(dir, "src", "app.ts"), size: 0, mtime: 0, id: "1:2", directory: true });
  expect(await folderish).toBeNull();
  expect(back.root).toBe(dir);
  b.close();
  back.close();
});

test("a folder it can't read says so", async () => {
  const b = new dirBrowser.Browser(join(tmpdir(), "corgi-browse-nowhere-" + process.pid), () => {});
  await b.listed;
  expect(b.error).not.toBeNull();
  expect(shown(b, false)).toContain("Can't read this folder");
  b.close();
});
