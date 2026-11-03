import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "./git";

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

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-git-")));
  run("init", "-q", "-b", "main");
  write("keep.ts", "const a = 1;\n");
  write("old.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
  write("gone.md", "# Gone\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  run("checkout", "-q", "-b", "topic");
  write("keep.ts", "const a = 2;\n");
  run("commit", "-qam", "topic: change a");
  // Working copy: a rename with an edit, a deletion, an untracked file and a lockfile.
  run("mv", "old.txt", "new.txt");
  write("new.txt", "one\ntwo\nthree\nfour\nfive\nSIX\n");
  run("rm", "-q", "gone.md");
  write("fresh.ts", "export {};\nconst b = 3;\n");
  write("bun.lock", "{}\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("batch recognition accepts only existing, unambiguous commit objects", async () => {
  const hash = run("rev-parse", "HEAD"),
    blob = run("rev-parse", "HEAD:keep.ts");
  const found = await git.recognizeCommits(root, [
    hash.slice(0, 8).toUpperCase(),
    blob.slice(0, 8),
    "12345678",
    "--help",
    "HEAD\nHEAD",
  ]);
  expect([...found]).toEqual([[hash.slice(0, 8), hash]]);
  expect(await git.recognizeCommits(join(root, "does-not-exist"), [hash])).toEqual(new Map());
});

test("a resolved range compares its endpoints and excludes the dirty worktree", async () => {
  const source = await git.resolveRevision(root, { kind: "range", from: "main", to: "HEAD" });
  expect(source).toEqual({ kind: "range", from: run("rev-parse", "main"), to: run("rev-parse", "HEAD") });
  const changes = await git.changes(root, source);
  expect(changes.map(c => c.path)).toEqual(["keep.ts"]);
  const loaded = await git.fileDiff(root, source, changes[0]);
  expect(loaded.kind === "diff" && [loaded.diff.old, loaded.diff.new]).toEqual([["const a = 1;"], ["const a = 2;"]]);
  expect(await git.changes(root, await git.resolveRevision(root, { kind: "range", from: "HEAD", to: "HEAD" }))).toEqual(
    [],
  );
  await expect(git.resolveRevision(root, { kind: "commit", hash: "missing-revision" })).rejects.toThrow("No commit");
  await expect(git.resolveRevision(root, { kind: "commit", hash: "--help" })).rejects.toThrow("No commit");
});

test("parses raw and numstat records together, renames included", () => {
  const raw =
    ":100644 100644 a b M\0src/a.ts\0:100644 100644 c d R086\0old.txt\0new.txt\0:000000 100644 0 e A\0x.png\0" +
    "3\t1\tsrc/a.ts\0" +
    "1\t1\t\0old.txt\0new.txt\0" +
    "-\t-\tx.png\0";
  expect(git.parseChanges(raw)).toEqual([
    {
      path: "src/a.ts",
      from: null,
      kind: "modified",
      adds: 3,
      dels: 1,
      binary: false,
      generated: false,
      funcname: false,
    },
    {
      path: "new.txt",
      from: "old.txt",
      kind: "renamed",
      adds: 1,
      dels: 1,
      binary: false,
      generated: false,
      funcname: false,
    },
    {
      path: "x.png",
      from: null,
      kind: "added",
      adds: null,
      dels: null,
      binary: true,
      generated: false,
      funcname: false,
    },
  ]);
});

test("finds the checkout, its base, and the branch's own commits", async () => {
  expect(await git.toplevel(root)).toBe(root);
  const base = await git.base(root);
  expect(base?.name).toBe("main");
  const commits = await git.commits(root, base);
  expect(commits.map(c => c.subject)).toEqual(["topic: change a"]);
  // Each commit says how much it touched before it's opened.
  expect(commits.map(c => [c.files, c.adds, c.dels])).toEqual([[1, 1, 1]]);
  // Without a base, the latest commits stand in.
  expect((await git.commits(root, null)).map(c => [c.subject, c.files, c.adds, c.dels])).toEqual([
    ["topic: change a", 1, 1, 1],
    ["base", 3, 8, 0],
  ]);
});

test("the base is main, from whichever copy the branch forked from latest", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-base-")));
  const at = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
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
  try {
    at("init", "-q", "-b", "main");
    at("commit", "-q", "--allow-empty", "-m", "pushed");
    at("update-ref", "refs/remotes/origin/main", "HEAD");
    // Main has a commit origin hasn't seen, and the branch forks after it.
    at("commit", "-q", "--allow-empty", "-m", "not pushed");
    at("checkout", "-q", "-b", "topic");
    at("commit", "-q", "--allow-empty", "-m", "topic: one");
    let base = await git.base(repo);
    expect(base?.name).toBe("main");
    expect((await git.commits(repo, base)).map(c => c.subject)).toEqual(["topic: one"]);
    // Origin moved on and the branch forked from it, past a stale local main.
    at("checkout", "-q", "main");
    at("reset", "-q", "--hard", "HEAD~1");
    at("checkout", "-q", "-b", "fresh", "origin/main");
    at("commit", "-q", "--allow-empty", "-m", "upstream");
    at("update-ref", "refs/remotes/origin/main", "HEAD");
    at("commit", "-q", "--allow-empty", "-m", "fresh: one");
    base = await git.base(repo);
    expect(base?.name).toBe("main");
    expect((await git.commits(repo, base)).map(c => c.subject)).toEqual(["fresh: one"]);
    // On main itself, what it hasn't pushed is what there is to review.
    at("checkout", "-q", "main");
    at("commit", "-q", "--allow-empty", "-m", "main: local");
    base = await git.base(repo);
    expect(base?.name).toBe("origin/main");
    expect((await git.commits(repo, base)).map(c => c.subject)).toEqual(["main: local"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a merge stands for the commits it brought in", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-merge-")));
  const at = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  try {
    at("init", "-q", "-b", "main");
    at("commit", "-q", "--allow-empty", "-m", "base");
    at("checkout", "-q", "-b", "topic");
    writeFileSync(join(repo, "a.txt"), "a\n");
    at("add", ".");
    at("commit", "-q", "-m", "topic: a");
    at("checkout", "-q", "-b", "side");
    for (const name of ["b", "c"]) {
      writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
      at("add", ".");
      at("commit", "-q", "-m", `side: ${name}`);
    }
    at("checkout", "-q", "topic");
    at("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const commits = await git.commits(repo, await git.base(repo));
    expect(commits.map(c => [c.subject, c.files, c.adds])).toEqual([
      ["merge side", 2, 2],
      ["topic: a", 1, 1],
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reads a commit's stat, including one without deletions", () => {
  const raw =
    "\x1eaaaaaaa1\x001700000000\x00one\n\n 2 files changed, 5 insertions(+), 1 deletion(-)\n" +
    "\x1ebbbbbbb2\x001700000100\x00two\n\n 1 file changed, 9 insertions(+)\n" +
    "\x1eccccccc3\x001700000200\x00merge\n";
  expect(git.parseLog(raw).map(c => [c.subject, c.files, c.adds, c.dels])).toEqual([
    ["one", 2, 5, 1],
    ["two", 1, 9, 0],
    ["merge", 0, 0, 0],
  ]);
});

test("the branch lists commits and the working copy together", async () => {
  const base = (await git.base(root))!;
  const listed = await git.changes(root, { kind: "worktree", against: base.merge_base });
  const by = Object.fromEntries(listed.map(c => [c.path, c]));
  expect(by["keep.ts"].kind).toBe("modified");
  expect(by["gone.md"].kind).toBe("deleted");
  expect(by["new.txt"]).toMatchObject({ kind: "renamed", from: "old.txt", adds: 1, dels: 1 });
  expect(by["fresh.ts"]).toMatchObject({ kind: "untracked", adds: 2 });
  expect(by["bun.lock"].generated).toBe(true);
  // Uncommitted leaves the branch's commit out.
  const head = (await git.head(root))!;
  const uncommitted = await git.changes(root, { kind: "worktree", against: head });
  expect(uncommitted.some(c => c.path === "keep.ts")).toBe(false);
});

test("a commit lists only what it changed", async () => {
  const head = (await git.head(root))!;
  const listed = await git.changes(root, { kind: "commit", hash: head });
  expect(listed.map(c => c.path)).toEqual(["keep.ts"]);
  const loaded = await git.fileDiff(root, { kind: "commit", hash: head }, listed[0]);
  expect(loaded.kind === "diff" && loaded.diff.new).toEqual(["const a = 2;"]);
});

test("each kind of change loads a whole-file diff", async () => {
  const base = (await git.base(root))!;
  const source: git.Source = { kind: "worktree", against: base.merge_base };
  const listed = await git.changes(root, source);
  const load = async (path: string) =>
    git.fileDiff(
      root,
      source,
      listed.find(c => c.path === path)!,
    );
  const renamed = await load("new.txt");
  expect(renamed.kind === "diff" && [renamed.diff.old.length, renamed.diff.new.length, renamed.diff.adds]).toEqual([
    6, 6, 1,
  ]);
  const fresh = await load("fresh.ts");
  expect(fresh.kind === "diff" && fresh.diff.new).toEqual(["export {};", "const b = 3;"]);
  const gone = await load("gone.md");
  expect(gone.kind === "diff" && gone.diff.old).toEqual(["# Gone"]);
});

test("a file over the budget is never read", async () => {
  write("big.txt", "x".repeat(2_100_000));
  const change: git.Change = {
    path: "big.txt",
    from: null,
    kind: "untracked",
    adds: null,
    dels: 0,
    binary: false,
    generated: false,
    funcname: false,
  };
  expect(await git.fileDiff(root, { kind: "worktree", against: "HEAD" }, change)).toEqual({
    kind: "too_large",
    bytes: 2_100_000,
  });
  rmSync(join(root, "big.txt"));
});

test("a diff driver with a funcname rule names folds with git's headers", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "corgi-review-funcname-")));
  const at = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]).toString();
  const lines = (head: string) => [head, ...Array.from({ length: 12 }, (_, i) => `x${i}`), "old", ""].join("\n");
  try {
    at("init", "-q");
    at("config", "diff.sections.xfuncname", "^\\[.*\\]$");
    writeFileSync(join(repo, ".gitattributes"), "*.tex diff=tex\n*.cfg diff=sections\n*.dat diff=plain\n");
    const files = { "a.tex": "\\section{Intro}", "a.cfg": "[server]", "a.dat": "head" };
    for (const [name, head] of Object.entries(files)) writeFileSync(join(repo, name), lines(head));
    at("add", ".");
    at("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    for (const [name, head] of Object.entries(files))
      writeFileSync(join(repo, name), lines(head).replace("old", "new"));
    const source: git.Source = { kind: "worktree", against: "HEAD" };
    const by = Object.fromEntries((await git.changes(repo, source)).map(c => [c.path, c]));
    expect([by["a.tex"].funcname, by["a.cfg"].funcname, by["a.dat"].funcname]).toEqual([true, true, false]);
    const headers = async (name: string) => {
      const loaded = await git.fileDiff(repo, source, by[name]);
      return loaded.kind === "diff" ? loaded.diff.headers : undefined;
    };
    expect(await headers("a.tex")).toEqual(new Map([[11, "\\section{Intro}"]]));
    expect(await headers("a.cfg")).toEqual(new Map([[11, "[server]"]]));
    expect(await headers("a.dat")).toBeNull();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
