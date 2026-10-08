import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracker, command, clean, parseCommits, Commits } from "./git_status";
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
    t.deinit();
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
  w.follow("/after");
  expect(t.apply(s)).toBe(false);
  expect(w.git_ahead).toBeNull();
  expect(w.git_ref.head).toBe("");
});
test("commit metadata strips terminal controls and preserves Unicode", () => {
  const c = parseCommits("abc\0Person\x1b\0date\x00123\0fix 项目\x07\0");
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
    tracker.deinit();
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
