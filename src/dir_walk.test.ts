import { afterEach, expect, test } from "bun:test";
import { Dir, type Dirent, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dirWalk from "./dir_walk";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "corgi-walk-")));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
function git(dir: string, ...args: string[]): void {
  const out = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (out.exitCode !== 0) throw Error(out.stderr.toString());
}
async function walked(root: string, limits = dirWalk.limits, signal = new AbortController().signal) {
  const entries: dirWalk.Entry[] = [],
    progress: dirWalk.Progress[] = [];
  const end = await dirWalk.walk(
    root,
    (batch, p) => {
      entries.push(...batch);
      progress.push(p);
    },
    signal,
    limits,
  );
  const paths = entries.map(e => (e.directory ? e.path + "/" : e.path)).sort();
  return { end, paths, progress };
}

test("in a Git work tree, lists tracked and untracked files and their folders, not ignored ones", async () => {
  const dir = folder({
    ".gitignore": "dist/\n*.log\n",
    "src/app.ts": "",
    "src/lib/util.ts": "",
    "notes.md": "",
    "dist/out.js": "",
    "debug.log": "",
  });
  git(dir, "init", "-q");
  git(dir, "add", ".gitignore", "src");
  git(dir, "commit", "-qm", "x");
  const { end, paths } = await walked(dir);
  expect(end).toEqual({ mode: "git", scanned: 6, done: true, capped: null, error: null });
  expect(paths).toEqual([".gitignore", "notes.md", "src/", "src/app.ts", "src/lib/", "src/lib/util.ts"]);
  // From a folder inside it, paths start there.
  expect((await walked(join(dir, "src"))).paths).toEqual(["app.ts", "lib/", "lib/util.ts"]);
  // An ignored folder has nothing in Git, so its files are walked.
  const ignored = await walked(join(dir, "dist"));
  expect(ignored.end.mode).toBe("files");
  expect(ignored.paths).toEqual(["out.js"]);
});

test("a file a merge left in conflict is listed once", async () => {
  const dir = folder({ "a.txt": "base\n", "b.txt": "" });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", "other");
  writeFileSync(join(dir, "a.txt"), "other\n");
  git(dir, "commit", "-qam", "other");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "a.txt"), "main\n");
  git(dir, "commit", "-qam", "main");
  expect(() => git(dir, "merge", "-q", "other")).toThrow();
  const { end, paths } = await walked(dir);
  expect(paths).toEqual(["a.txt", "b.txt"]);
  expect(end.scanned).toBe(2);
});

test("elsewhere, walks the file system a level at a time, past .git and through a link only once", async () => {
  const dir = folder({ "a/b/c.txt": "", "a/x.txt": "", "top.txt": "", ".git/HEAD": "", "a/.git/config": "" });
  // A link back up would loop; one to a folder outside leads there once.
  symlinkSync(dir, join(dir, "a", "b", "up"));
  const outside = folder({ "far.txt": "" });
  symlinkSync(outside, join(dir, "far"));
  symlinkSync(outside, join(dir, "a", "far-again"));
  const { end, paths, progress } = await walked(dir);
  expect(end.mode).toBe("files");
  expect(paths).toEqual([
    "a/",
    "a/b/",
    "a/b/c.txt",
    "a/b/up/",
    "a/far-again/",
    "a/x.txt",
    "far/",
    "far/far.txt",
    "top.txt",
  ]);
  // Shallow entries come first.
  expect(progress.at(-1)!.done).toBe(true);
});

test("stops at its entry and time caps, saying which", async () => {
  const dir = folder(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`d${i % 3}/f${i}.txt`, ""])));
  const few = await walked(dir, { entries: 10, ms: 10_000 });
  expect(few.end).toMatchObject({ scanned: 10, capped: "entries", done: true });
  expect(few.paths).toHaveLength(10);
  const quick = await walked(dir, { entries: 1000, ms: 0 });
  expect(quick.end).toMatchObject({ capped: "time", done: true });
  // A Git listing stops at the cap too.
  git(dir, "init", "-q");
  const listed = await walked(dir, { entries: 7, ms: 10_000 });
  expect(listed.end).toMatchObject({ mode: "git", scanned: 7, capped: "entries" });
});

test("a walk cancelled sends nothing more", async () => {
  const dir = folder(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`d${i % 20}/e${i % 7}/f${i}.txt`, ""])));
  const abort = new AbortController();
  let batches = 0;
  const done = dirWalk.walk(
    dir,
    () => {
      batches++;
      abort.abort();
    },
    abort.signal,
  );
  abort.abort();
  const end = await done;
  expect(batches).toBe(0);
  expect(end.done).toBe(true);
  expect(end.scanned).toBeLessThan(200 + 20 + 140);
});

/** Counts the folder entries read, calling `each` with the count. */
async function counting<T>(each: (read: number) => void, run: () => Promise<T>): Promise<T> {
  const original = Dir.prototype[Symbol.asyncIterator];
  let read = 0;
  Dir.prototype[Symbol.asyncIterator] = async function* (this: Dir): AsyncGenerator<Dirent, undefined> {
    for await (const entry of original.call(this)) {
      each(++read);
      yield entry;
    }
    return undefined;
  };
  try {
    return await run();
  } finally {
    Dir.prototype[Symbol.asyncIterator] = original;
  }
}

test("reads a big folder only as far as its cap, and no further once cancelled", async () => {
  const dir = folder(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`big/f${i}`, ""])));
  let read = 0;
  const few = await counting(
    n => (read = n),
    () => walked(dir, { entries: 10, ms: 10_000 }),
  );
  expect(few.end).toMatchObject({ scanned: 10, capped: "entries" });
  expect(read).toBeLessThan(50);
  const abort = new AbortController();
  read = 0;
  await counting(
    n => {
      read = n;
      if (n === 20) abort.abort();
    },
    () => dirWalk.walk(dir, () => {}, abort.signal),
  );
  expect(read).toBeLessThan(50);
});

test("a folder and a link to it are walked once", async () => {
  const dir = folder({ "data/x.txt": "", "data/deep/y.txt": "" });
  symlinkSync(join(dir, "data"), join(dir, "alias"));
  const { paths } = await walked(dir);
  expect(paths).toContain("alias/");
  expect(paths.filter(path => path.endsWith("x.txt"))).toHaveLength(1);
  expect(paths.filter(path => path.endsWith("y.txt"))).toHaveLength(1);
});

test("a folder that isn't there fails by name", async () => {
  const { end } = await walked(join(tmpdir(), "corgi-walk-nowhere-" + process.pid));
  expect(end).toMatchObject({ done: true, error: "NotADirectory" });
});
