import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracker, changedPaths, parseBase, parseChanges, parseInventory, parseNumstat, reflogStart } from "./worktrees";
import * as worktrees from "../worktrees";
import { Store, Workspace } from "../workspace";
import type { Runtime } from "../runtime";

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (status !== 0) throw Error(err);
  return out;
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corgi-worktrees-")));
  const repo = join(root, "project");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base"), "base\n");
  await git(repo, "add", "base");
  await git(repo, "commit", "-m", "base");
  return { root, repo, close: () => rm(root, { recursive: true, force: true }) };
}
test("line counts, changed paths and reflog times parse from Git's records", () => {
  expect(parseNumstat("12\t3\tsrc/a.ts\0-\t-\tlogo.png\0" + "4\t1\t\0old.ts\0new.ts\0")).toEqual({
    added: 16,
    removed: 4,
  });
  expect(changedPaths(" M src/a.ts\0R  new.ts\0old.ts\0?? notes.md\0!! ignored\0")).toEqual([
    { path: "src/a.ts", untracked: false },
    { path: "new.ts", untracked: false },
    { path: "notes.md", untracked: true },
  ]);
  const reflog = "0000 2b2f Test <test@example.com> 1791744624 -0400\treset: moving to HEAD\nmore";
  expect(reflogStart(reflog)).toBe(1791744624);
  expect(reflogStart("")).toBeNull();
});
test("NUL worktree and status records retain odd paths, flags and rename counts", () => {
  const entries = parseInventory(
    'worktree /project\0HEAD abc\0branch refs/heads/main\0\0worktree /odd "path"\n\0HEAD def\0detached\0locked keep\0prunable gone\0\0',
  );
  expect(entries[0].primary).toBe(true);
  expect(entries[1]).toMatchObject({
    path: '/odd "path"\n',
    detached: true,
    locked: "keep",
    prunable: "gone",
    primary: false,
  });
  expect(parseChanges("RM new\0old\0?? untracked\nname\0UU conflict\0 M modified\0")).toEqual({
    total: 4,
    staged: 1,
    modified: 2,
    untracked: 1,
    conflicted: 1,
    added: 0,
    removed: 0,
  });
  expect(parseBase("refs/heads/topic\0" + "a".repeat(40) + "\0\n")).toBeNull();
  expect(
    parseBase(
      `refs/heads/develop\0${"a".repeat(40)}\0\nrefs/remotes/origin/HEAD\0${"a".repeat(40)}\0refs/remotes/origin/develop\n`,
    )?.name,
  ).toBe("develop");
});
test("inventory is cheap; details compare local main and count local changes without an upstream", async () => {
  const f = await fixture(),
    started = Date.now();
  const calls: string[][] = [];
  const tracker = new Tracker(async (cwd, args) => {
    calls.push(args);
    try {
      return await git(cwd, ...args);
    } catch {
      return null;
    }
  });
  try {
    const nested = join(f.repo, ".worktrees", "search"),
      external = join(f.root, "external\ncheckout");
    await git(f.repo, "worktree", "add", "-b", "feat/search", nested);
    await git(f.repo, "worktree", "add", "--detach", external);
    await git(nested, "commit", "--allow-empty", "-m", "feature");
    await git(f.repo, "commit", "--allow-empty", "-m", "main advanced");
    await writeFile(join(nested, "base"), "changed\n");
    await git(nested, "add", "base");
    await writeFile(join(nested, "new"), "untracked\n");
    const inventory = await tracker.refresh(f.repo, false, 1000);
    expect(worktrees.linked(inventory)).toHaveLength(2);
    expect(calls.some(a => a[0] === "status" || a[0] === "rev-list")).toBe(false);
    const details = await tracker.refresh(f.repo, true, 1001);
    expect(details?.base?.name).toBe("main");
    expect(details?.entries.find(e => e.path === nested)).toMatchObject({
      comparison: { ahead: 1n, behind: 1n },
      // A staged line replaced, and an untracked file's line.
      changes: { total: 2, staged: 1, untracked: 1, added: 2, removed: 1 },
    });
    const search = details!.entries.find(e => e.path === nested)!;
    expect(search.created).toBeGreaterThanOrEqual(Math.floor(started / 1000) * 1000);
    expect(search.edited).toBeGreaterThanOrEqual(search.created!);
    expect(details?.entries.find(e => e.path === external)).toMatchObject({
      detached: true,
      comparison: { ahead: 0n, behind: 1n },
    });
    const before = calls.length;
    expect(await tracker.refresh(f.repo, true, 1002)).toBe(details);
    expect(calls).toHaveLength(before);
    // Another Corgi workspace in the same repository only resolves its common directory.
    const again = await tracker.refresh(nested, true, 1002);
    expect(again).toBe(details);
    expect(calls.slice(before).map(a => a[0])).toEqual(["rev-parse"]);
    // Changes and their line counts refresh independently; unchanged commits
    // do not rescan history.
    calls.length = 0;
    await tracker.refresh(f.repo, true, 4002);
    expect(calls.map(a => a[0]).sort()).toEqual(["diff", "diff", "status", "status"]);
    expect((await git(f.repo, "status", "--porcelain")).includes(".worktrees/")).toBe(true);
  } finally {
    tracker.close();
    await f.close();
  }
}, 20000);
test("inventory follows removal, main movement and packed refs; failures preserve known data", async () => {
  const f = await fixture();
  let fail = false;
  const calls: string[][] = [];
  const tracker = new Tracker(async (cwd, args) => {
    calls.push(args);
    if (fail) return null;
    try {
      return await git(cwd, ...args);
    } catch {
      return null;
    }
  });
  try {
    const child = join(f.root, "child");
    await git(f.repo, "worktree", "add", "-b", "feature", child);
    await git(child, "commit", "--allow-empty", "-m", "feature");
    let snapshot = await tracker.refresh(f.repo, true, 1000);
    expect(snapshot?.entries[1].comparison?.ahead).toBe(1n);
    await git(f.repo, "merge", "--ff-only", "feature");
    await git(f.repo, "pack-refs", "--all");
    snapshot = await tracker.refresh(f.repo, true, 12000, snapshot);
    expect(snapshot?.entries[1].comparison).toEqual({ ahead: 0n, behind: 0n });
    await rm(child, { recursive: true, force: true });
    await git(f.repo, "commit", "--allow-empty", "-m", "advance main");
    calls.length = 0;
    snapshot = await tracker.refresh(f.repo, true, 23000, snapshot);
    expect(snapshot?.entries[1]).toMatchObject({ available: false });
    expect(snapshot?.entries[1].prunable).not.toBeNull();
    expect(snapshot?.entries).toHaveLength(2);
    expect(worktrees.linked(snapshot)).toHaveLength(0);
    expect(calls.some(args => args[0] === "rev-list" || args[0] === "status")).toBe(false);
    fail = true;
    const failed = await tracker.refresh(f.repo, true, 34000, snapshot);
    expect(failed?.stale).toBe(true);
    expect(failed?.entries).toEqual(snapshot?.entries);
    fail = false;
    await git(f.repo, "worktree", "prune");
    snapshot = await tracker.refresh(f.repo, true, 65000, failed);
    expect(snapshot?.stale).toBe(false);
    expect(worktrees.linked(snapshot)).toHaveLength(0);
  } finally {
    tracker.close();
    await f.close();
  }
}, 20000);
test("associations resolve symlinks and successful writes, without claiming a nested independent repository or a write outside the checkouts", async () => {
  const f = await fixture(),
    tracker = new Tracker();
  try {
    const child = join(f.repo, ".worktrees", "search"),
      alias = join(f.root, "alias");
    await git(f.repo, "worktree", "add", "-b", "feature", child);
    await symlink(child, alias);
    const nested = join(child, "separate");
    await mkdir(nested);
    await git(nested, "init", "-b", "main");
    const snapshot = await tracker.refresh(f.repo, false, 1000);
    const associations = await (tracker as any).associate(
      snapshot,
      [
        { target: { pane: 1 }, cwd: alias, writes: [] },
        { target: { pane: 2 }, cwd: f.repo, writes: [join(child, "new-file")] },
        { target: { pane: 3 }, cwd: nested, writes: [] },
        { target: { pane: 4 }, cwd: child, writes: [join(f.root, "scratch", "page.html")] },
      ],
      1000,
      null,
    );
    expect(associations).toEqual([
      { target: { pane: 1 }, path: child, source: "cwd", stale: false },
      { target: { pane: 2 }, path: child, source: "write", stale: false },
      { target: { pane: 4 }, path: child, source: "cwd", stale: false },
    ]);
  } finally {
    tracker.close();
    await f.close();
  }
}, 20000);
test("a scan cannot follow a workspace through a directory edit, even when it returns to the old path", () => {
  const workspace = new Workspace(1, "/project"),
    store = new Store();
  store.items = [workspace];
  const runtime = { workspaces: store } as Runtime,
    tracker = new Tracker();
  tracker.jobs = [
    {
      workspace,
      cwd: workspace.cwd,
      epoch: workspace.git_epoch,
      inputs: [],
      detail: false,
      result: { common_dir: "/project/.git", entries: [], agents: [], base: null, stale: false },
    },
  ];
  workspace.follow("/elsewhere");
  workspace.follow("/project");
  expect(tracker.apply(runtime)).toBe(false);
  expect(workspace.worktrees).toBeNull();
  tracker.close();
});
/** The workspace's removal once it has ended. */
async function finished(tracker: Tracker, workspace: number) {
  for (let i = 0; i < 2000; i++) {
    const report = tracker.removal(workspace);
    if (report && report.phase !== "deleting") return report;
    await Bun.sleep(5);
  }
  throw Error("Timeout");
}
test("removal deletes a worktree and its uncommitted work but keeps the branch; locked and lived-in ones are refused", async () => {
  const f = await fixture();
  try {
    const topic = join(f.root, "topic"),
      locked = join(f.root, "locked"),
      lived = join(f.root, "lived");
    await git(f.repo, "worktree", "add", "-b", "topic", topic);
    await git(f.repo, "worktree", "add", "-b", "kept", locked);
    await git(f.repo, "worktree", "lock", "--reason", "on a USB disk", locked);
    await git(f.repo, "worktree", "add", "-b", "lived", lived);
    await writeFile(join(topic, "draft"), "unsaved\n");
    const workspace = new Workspace(1, f.repo),
      other = new Workspace(2, lived),
      store = new Store();
    store.items = [workspace, other];
    const runtime = { workspaces: store } as Runtime,
      tracker = new Tracker();
    workspace.worktrees = await tracker.refresh(f.repo, true);
    await expect(tracker.remove(runtime, 1, join(f.root, "nowhere"))).rejects.toThrow("NoWorktree");
    await expect(tracker.remove(runtime, 1, locked)).rejects.toThrow("WorktreeLocked");
    await expect(tracker.remove(runtime, 1, lived)).rejects.toThrow("WorktreeInUse");
    await expect(tracker.remove(runtime, 3, topic)).rejects.toThrow("NoWorkspace");
    const id = await tracker.remove(runtime, 1, topic);
    await expect(tracker.remove(runtime, 1, topic)).rejects.toThrow("WorktreeRemoving");
    expect(await finished(tracker, 1)).toMatchObject({ id, path: topic, phase: "done" });
    expect(await Bun.file(join(topic, "draft")).exists()).toBe(false);
    expect((await git(f.repo, "branch", "--list", "topic")).trim()).toBe("topic");
    const after = await tracker.refresh(f.repo, false);
    expect(
      worktrees
        .linked(after)
        .map(e => e.path)
        .sort(),
    ).toEqual([lived, locked]);
    tracker.close();
  } finally {
    await f.close();
  }
}, 20000);
test("a removal runs in the background, and stopping it kills Git and keeps the worktree", async () => {
  const f = await fixture();
  try {
    const big = join(f.root, "big");
    await git(f.repo, "worktree", "add", "-b", "big", big);
    for (let d = 0; d < 40; d++) {
      await mkdir(join(big, "node_modules", `p${d}`), { recursive: true });
      for (let i = 0; i < 50; i++) await writeFile(join(big, "node_modules", `p${d}`, `f${i}`), "");
    }
    const workspace = new Workspace(1, f.repo),
      store = new Store();
    store.items = [workspace];
    const runtime = { workspaces: store, panes: [], sessions: [] } as unknown as Runtime,
      tracker = new Tracker();
    workspace.worktrees = await tracker.refresh(f.repo, true);
    await tracker.remove(runtime, 1, big);
    expect(tracker.removal(1)?.phase).toBe("deleting");
    // How it goes reaches viewers through the tracker's tick.
    expect(tracker.tick(runtime)).toBe(true);
    tracker.stopRemoval(1);
    expect((await finished(tracker, 1)).phase).toBe("stopped");
    // Git's record of it stays, short of the files already deleted.
    const after = await tracker.refresh(f.repo, false);
    expect(worktrees.linked(after).map(e => e.path)).toEqual([big]);
    tracker.close();
  } finally {
    await f.close();
  }
}, 30000);
