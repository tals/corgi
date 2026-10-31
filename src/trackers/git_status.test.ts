import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracker, clean, parseCommits, parseShortstat, Commits } from "./git_status";
import { Store, Workspace } from "../workspace";
import { Ref } from "./git_push";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const git = async (cwd: string, ...args: string[]) => {
  const { stdout } = await promisify(execFile)("git", ["-C", cwd, ...args]);
  return stdout.trim();
};
test("upstream counts follow commits and packed refs, deduplicate subdirectories and isolate worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-git-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "commit", "--allow-empty", "-m", "base");
    await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(repo, "config", "remote.origin.url", join(root, "remote"));
    await git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(repo, "branch", "--set-upstream-to=origin/main");
    await git(repo, "commit", "--allow-empty", "-m", "ahead");
    await mkdir(join(repo, "nested"));
    const t = new Tracker();
    expect(await t.refresh(repo, 1000)).toBe(1n);
    expect(await t.refresh(join(repo, "nested"), 1000)).toBe(1n);
    expect(t.cache.size).toBe(1);
    await git(repo, "pack-refs", "--all");
    expect(await t.refresh(repo, 4000)).toBe(1n);
    await git(repo, "commit", "--allow-empty", "-m", "another");
    expect(await t.refresh(repo, 7000)).toBe(2n);
    const worktree = join(root, "worktree");
    await git(repo, "worktree", "add", "-b", "topic", worktree);
    await git(worktree, "branch", "--set-upstream-to=origin/main");
    await git(worktree, "commit", "--allow-empty", "-m", "topic");
    expect(await t.refresh(worktree, 10000)).toBe(3n);
    expect(await t.refresh(repo, 10000)).toBe(2n);
    t.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("background result cannot follow a workspace into a different directory", () => {
  const s = new Store(),
    w = new Workspace(1, "/before");
  s.items = [w];
  const t = new Tracker();
  t.jobs = [
    {
      id: 1,
      cwd: "/before",
      ahead: 3n,
      ref: new Ref({ head: "head" }),
      commits: new Commits(),
    },
  ];
  w.move("/after");
  expect(t.apply(s)).toBe(false);
  expect(w.git_ahead).toBeNull();
  expect(w.git_ref.head).toBe("");
});
test("clearing a push failure notifies viewers even when git status is unchanged", () => {
  const store = new Store(),
    workspace = new Workspace(1, "/repo"),
    tracker = new Tracker();
  store.items = [workspace];
  workspace.git_ref = Ref.init("/repo", "head", "refs/heads/main", "origin", "refs/heads/main");
  workspace.git_ahead = 0n;
  workspace.git_push.phase = "failed";
  workspace.git_push.message = "rejected";
  tracker.jobs = [
    {
      id: workspace.id,
      cwd: workspace.cwd,
      ahead: 0n,
      ref: new Ref(workspace.git_ref.view()),
      commits: new Commits(),
    },
  ];
  expect(tracker.apply(store)).toBe(true);
  expect(workspace.git_push.view()).toEqual({ phase: "idle", message: "" });
});
test("commit metadata strips terminal controls and preserves Unicode", () => {
  const c = parseCommits("\x1eabc\0Person\x1b\0date\x00123\0fix 项目\x07");
  expect(c.len).toBe(1);
  expect(c.items[0].author.text()).toBe("Person ");
  expect(c.items[0].subject.text()).toBe("fix 项目 ");
  expect(clean("é☃\u0085\x1b", 20)).toBe("é☃  ");
});

test("test clock advance makes a tracker refresh deadline due", async () => {
  const clock = await import("../clock");
  const tracker = new Tracker();
  const store = new Store();
  try {
    tracker.tick(store);
    await tracker.thread;
    const deadline = tracker.next_refresh;
    clock.advance(3001);
    tracker.tick(store);
    expect(tracker.next_refresh).toBeGreaterThan(deadline);
    await tracker.thread;
  } finally {
    tracker.close();
    clock.reset();
  }
});
test("an unchanged repository reuses its answer until its refs move", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-git-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "commit", "--allow-empty", "-m", "base");
    await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(repo, "config", "remote.origin.url", join(root, "remote"));
    await git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(repo, "branch", "--set-upstream-to=origin/main");
    await git(repo, "commit", "--allow-empty", "-m", "one");
    await git(repo, "commit", "--allow-empty", "-m", "two");
    const t = new Tracker();
    expect(await t.refresh(repo, 1000)).toBe(2n);
    const cached = [...t.cache.values()][0];
    expect(cached.checked).toBe(1000);
    expect(await t.refresh(repo, 4000)).toBe(2n);
    expect(cached.checked).toBe(1000);
    // A fetch moves the upstream.
    await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    expect(await t.refresh(repo, 7000)).toBe(1n);
    // An unchanged repository still runs git once its recheck is due.
    const again = [...t.cache.values()][0];
    expect(await t.refresh(repo, 70000)).toBe(1n);
    expect(again.checked).toBe(70000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shortstats count files and lines, with either count left out", () => {
  expect(parseShortstat(" 3 files changed, 12 insertions(+), 1 deletion(-)")).toEqual({
    files: 3,
    insertions: 12,
    deletions: 1,
  });
  expect(parseShortstat(" 1 file changed, 2 deletions(-)")).toEqual({ files: 1, insertions: 0, deletions: 2 });
  expect(parseShortstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
});
test("unpushed commits carry their diffs and the one a push would send", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-git-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    await git(root, "commit", "--allow-empty", "-m", "base");
    await git(root, "branch", "upstream");
    await git(root, "branch", "--set-upstream-to=upstream");
    await Bun.write(join(root, "a.txt"), "one\ntwo\n");
    await Bun.write(join(root, "b.txt"), "three\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "add");
    await Bun.write(join(root, "a.txt"), "one\n");
    await git(root, "commit", "-am", "trim");
    await git(root, "commit", "--allow-empty", "-m", "empty");
    const t = new Tracker(),
      { commits } = await t.refreshInto(root, 1000);
    expect(commits.diff).toEqual({ files: 2, insertions: 2, deletions: 0 });
    expect(commits.items.slice(0, commits.len).map(c => [c.subject.text(), c.diff])).toEqual([
      ["empty", { files: 0, insertions: 0, deletions: 0 }],
      ["trim", { files: 1, insertions: 0, deletions: 1 }],
      ["add", { files: 2, insertions: 3, deletions: 0 }],
    ]);
    t.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
