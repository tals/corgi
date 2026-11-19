import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "./git";
import * as reader from "./reader";
import * as service from "./service";

let root = "";
const run = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
    .toString()
    .trim();
const write = (path: string, text: string) => writeFileSync(join(root, path), text);
const long = Array.from({ length: 30_000 }, (_, i) => `line ${i} of a file long enough to need several replies`).join(
  "\n",
);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-service-")));
  run("init", "-q", "-b", "main");
  mkdirSync(join(root, "many"));
  for (let i = 0; i <= service.max_listed; i++) write(`many/${i}.txt`, "a\n");
  write("long.txt", "start\n");
  write("small.txt", "one\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  for (let i = 0; i <= service.max_listed; i++) write(`many/${i}.txt`, "a\nb\n");
  write("long.txt", long + "\n");
  write("small.txt", "two\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a listing names the first files and counts them all; an unchanged one isn't sent again", async () => {
  const first = await service.read({
    cwd: join(root, "many"),
    scope: "uncommitted",
    pick: null,
    reference: null,
    known: "",
  });
  expect(first.root).toBe(root);
  const listed = first.checkout!.listings[0];
  expect(listed.changes.length).toBe(service.max_listed);
  expect(listed.totals.files).toBe(service.max_listed + 3);
  expect(listed.totals.adds).toBe(service.max_listed + 1 + 30_000 + 1);
  expect(listed.stats!.length).toBe(service.max_listed);
  const again = await service.read({
    cwd: root,
    scope: "uncommitted",
    pick: null,
    reference: null,
    known: first.hash,
  });
  expect(again).toEqual({ root, hash: first.hash, same: true, checkout: null });
  // small.txt is past the listed files, but its lines count.
  write("small.txt", "three\nfour\n");
  const changed = await service.read({
    cwd: root,
    scope: "uncommitted",
    pick: null,
    reference: null,
    known: first.hash,
  });
  expect(changed.same).toBe(false);
  expect(changed.checkout).not.toBeNull();
  write("small.txt", "two\n");
});

test("a long diff comes in slices that fit a reply, and files past the budget wait for the next", async () => {
  const head = run("rev-parse", "HEAD");
  const source: git.Source = { kind: "worktree", against: head };
  const file = (path: string, offset = 0, hash = ""): service.DiffFile => ({
    path,
    from: null,
    kind: "modified",
    binary: false,
    funcname: false,
    offset,
    hash,
  });
  const whole = await git.fileText(root, source, { ...file("long.txt"), adds: null, dels: null, generated: false });
  if (whole.kind !== "text") throw Error(whole.kind);
  expect(whole.text.length).toBeGreaterThan(service.reply_chars * 2);
  const partial = new reader.Partial();
  let read: git.Text | null = null;
  let replies = 0;
  // The small file rides along with the first slice; the rest follow alone.
  let files = [file("long.txt"), file("small.txt")];
  while (!read) {
    const reply = await service.diffs({ root, source, files });
    replies++;
    const chars = reply.files.reduce((n, f) => n + (f.slice.kind === "text" ? f.slice.text.length : 0), 0);
    expect(chars).toBeLessThanOrEqual(service.reply_chars);
    const slice = reply.files[0].slice;
    if (slice.kind !== "text") throw Error(slice.kind);
    read = partial.add(slice);
    files = [file("long.txt", partial.offset, partial.hash)];
    if (replies === 1) expect(reply.files.map(f => f.path)).toEqual(["long.txt"]);
  }
  expect(replies).toBe(Math.ceil(whole.text.length / service.reply_chars));
  expect(read).toEqual(whole);
  const small = await service.diffs({ root, source, files: [file("small.txt"), file("long.txt")] });
  expect(small.files.map(f => f.path)).toEqual(["small.txt", "long.txt"]);
});

test("a listing of long paths stops at its share of path text", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-paths-"))),
    deep = join(repo, "d".repeat(200));
  try {
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    mkdirSync(deep);
    const count = Math.ceil(service.listed_chars / 200) + 100;
    for (let i = 0; i < count; i++) writeFileSync(join(deep, `${i}.txt`), "a\n");
    const reply = await service.read({ cwd: repo, scope: "uncommitted", pick: null, reference: null, known: "" });
    const listed = reply.checkout!.listings[0];
    expect(listed.totals.files).toBe(count);
    expect(listed.changes.length).toBeLessThan(count);
    expect(listed.changes.reduce((n, ch) => n + ch.path.length, 0)).toBeLessThanOrEqual(service.listed_chars);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a pick off the branch's own commits is read by its full hash", async () => {
  const side = run("commit-tree", `${run("rev-parse", "HEAD")}^{tree}`, "-p", "HEAD", "-m", "side");
  const reply = await service.read({ cwd: root, scope: "commits", pick: side.slice(0, 7), reference: null, known: "" });
  expect(reply.checkout!.error).toBeNull();
  expect(reply.checkout!.pick).toBe(side);
  // Its listing names a source a diffs request may carry.
  expect(service.source(reply.checkout!.listings[0].source)).toEqual({ kind: "commit", hash: side });
  // Another scope lists its files, even if the pick names no commit any more.
  const gone = "0".repeat(40);
  const all = await service.read({ cwd: root, scope: "all", pick: gone, reference: null, known: "" });
  expect(all.checkout!.error).toBeNull();
  expect(all.checkout!.listings[0].changes.length).toBeGreaterThan(0);
});

test("a slice of a text that changed starts it over", () => {
  const partial = new reader.Partial();
  const slice = (text: string, offset: number, total: number, hash: string) =>
    ({ kind: "text", text, offset, total, hash, headers: null }) as const;
  expect(partial.add(slice("ab", 0, 4, "x"))).toBeNull();
  expect(partial.add(slice("CD", 2, 4, "y"))).toBeNull();
  expect(partial.offset).toBe(0);
  expect(partial.add(slice("abcd", 0, 4, "y"))).toEqual({ kind: "text", text: "abcd", headers: null });
});

test("requests name commits and paths, never options or files outside the checkout", async () => {
  expect(service.revision({ kind: "range", from: "main", to: "HEAD~1" })).toEqual({
    kind: "range",
    from: "main",
    to: "HEAD~1",
  });
  expect(() => service.revision({ kind: "commit", hash: "--output=/tmp/x" })).toThrow();
  const pick = { cwd: root, scope: "commits", pick: "--output=/tmp/x", reference: null, known: "" } as const;
  expect(service.answer({ op: "review.read", payload: pick } as never)).rejects.toThrow("UnexpectedToken");
  expect(() => service.source({ kind: "worktree", against: "HEAD" })).toThrow();
  expect(service.source({ kind: "worktree", against: git.empty_tree })).toEqual({
    kind: "worktree",
    against: git.empty_tree,
  });
  const file = { path: "a.ts", kind: "modified" };
  expect(service.diffFiles([file])[0]).toMatchObject({ path: "a.ts", offset: 0, hash: "" });
  for (const path of ["../secret", "/etc/passwd", "a/../../b"])
    expect(() => service.diffFiles([{ ...file, path }])).toThrow("InvalidPath");
  expect(() => service.diffFiles(Array(service.max_files + 1).fill(file))).toThrow();
  // A folder in the home is this machine's.
  expect(service.folder("~/repo")).toBe(join(homedir(), "repo"));
  expect(service.folder("~")).toBe(homedir());
  expect(service.folder("/a/~/b")).toBe("/a/~/b");
});
