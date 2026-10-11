import { expect, test } from "bun:test";
import * as launcherWorktree from "./launcher_worktree";
import { default_template } from "./worktree_folder";
import type * as worktrees from "./worktrees";

const checkout = (path: string, branch: string, primary = false, total = 0): worktrees.Checkout => ({
  path,
  head: "4f1c2a9e0b",
  branch: `refs/heads/${branch}`,
  primary,
  bare: false,
  detached: false,
  locked: null,
  prunable: null,
  available: true,
  comparison: null,
  changes: { total, staged: 0, modified: total, untracked: 0, conflicted: 0 },
  stale: false,
});
const snapshot: worktrees.Snapshot = {
  common_dir: "/src/app/.git",
  base: { ref: "refs/heads/main", name: "main", head: "4f1c2a9e0b" },
  entries: [
    checkout("/src/app/.claude/worktrees/fix", "worktree-fix", false, 1),
    checkout("/src/app", "main", true, 2),
    checkout("/src/app-topic", "topic"),
  ],
  agents: [
    { target: { pane: 1 }, path: "/src/app-topic", source: "cwd", stale: false },
    { target: { pane: 2 }, path: "/src/app-topic", source: "write", stale: false },
  ],
  stale: false,
};

test("the title names the innermost checkout by branch, or the folder outside a repository", () => {
  expect(launcherWorktree.place(snapshot, "/src/app/.claude/worktrees/fix/src", null)).toEqual({
    label: "fix",
    worktree: true,
  });
  expect(launcherWorktree.place(snapshot, "/src/app/docs", null)).toEqual({ label: "main", worktree: true });
  expect(launcherWorktree.place(snapshot, "/src/application", null)).toEqual({
    label: "application",
    worktree: false,
  });
  const planned = { branch: "next", base: "refs/heads/main", base_name: "main", path: "/src/app-next" };
  expect(launcherWorktree.place(snapshot, "/src/app", planned)).toEqual({ label: "next", worktree: true });
});

test("the box opens in Branch over the checkouts, the primary first, the current one ticked", () => {
  const c = new launcherWorktree.Chooser();
  c.open(snapshot, "/src/app");
  expect([c.mode, c.focus]).toEqual(["open", "branch"]);
  // With the form's caret, the checkouts step back.
  expect(launcherWorktree.choices(snapshot, "/src/app", c).map(x => [x.hovered, x.dim])).toEqual([
    [false, true],
    [false, true],
    [false, true],
  ]);
  // Up lands on the last checkout, just above the form.
  c.toList(snapshot);
  expect([c.focus, c.hovered]).toEqual(["list", 2]);
  const choices = launcherWorktree.choices(snapshot, "/src/app", c);
  expect(choices.map(x => [x.text, x.note, x.current, x.hovered])).toEqual([
    ["main", "2 changed", true, false],
    ["fix", "1 changed", false, false],
    ["topic", "2 agents · clean", false, true],
  ]);
  expect(choices.some(x => x.dim)).toBe(false);
  c.move(snapshot, -1);
  expect([c.focus, c.hovered]).toEqual(["list", 1]);
  // Past the last is Branch again.
  c.move(snapshot, 2);
  expect(c.focus).toBe("branch");
  // A named worktree reopens in the form, on its name and base.
  c.planned = { branch: "x", base: "refs/heads/topic", base_name: "topic", path: "/src/app/.worktrees/x" };
  c.open(snapshot, "/src/app-topic");
  expect([c.focus, c.field.name(), c.base?.name]).toEqual(["branch", "x", "topic"]);
});

test("a new worktree goes where the template says, from main or the current branch", () => {
  expect(launcherWorktree.plannedPath(snapshot, "/src/app-topic", "feat/login", default_template)).toBe(
    "/src/app/.worktrees/feat-login",
  );
  expect(launcherWorktree.plannedPath(snapshot, "/src/app", "x", "$PROJECT_ROOT/../$PROJECT_NAME-$NAME")).toBe(
    "/src/app-x",
  );
  expect(launcherWorktree.folderLabel("/src/app/.worktrees/x", "/src/app")).toBe("./.worktrees/x");
  expect(launcherWorktree.folderLabel("/src/app-x", "/src/app")).toBe("../app-x");
  expect(launcherWorktree.bases(snapshot, "/src/app-topic").map(b => b.name)).toEqual(["main", "topic"]);
  expect(launcherWorktree.bases(snapshot, "/src/app").map(b => b.name)).toEqual(["main"]);
  const c = new launcherWorktree.Chooser();
  c.open(snapshot, "/src/app-topic");
  expect(c.base).toEqual({ ref: "refs/heads/main", name: "main" });
  for (const ch of "login") c.field.key(ch.charCodeAt(0));
  // From searches the branches, the ones starting with what's typed first.
  c.focusFrom();
  expect(launcherWorktree.pickChoices(c, 100)).toEqual([
    { text: "Reading branches…", note: "", current: false, hovered: false },
  ]);
  c.branches = launcherWorktree.branchList([
    { ref: "refs/remotes/origin/fix-topic", name: "origin/fix-topic", at: 99 },
    { ref: "refs/heads/main", name: "main", at: 40 },
    { ref: "refs/heads/topic", name: "topic", at: 10 },
    { bad: true },
  ]);
  c.focusFrom();
  expect(c.picked).toBe(1);
  expect(launcherWorktree.pickChoices(c, 100).map(x => [x.text, x.note, x.current, x.hovered])).toEqual([
    ["origin/fix-topic", "1m", false, false],
    ["main", "1m", true, true],
    ["topic", "1m", false, false],
  ]);
  for (const ch of "TOP") c.search(from => from.key(ch.charCodeAt(0)));
  expect(c.matches().map(b => b.name)).toEqual(["topic", "origin/fix-topic"]);
  for (const ch of "x") c.search(from => from.key(ch.charCodeAt(0)));
  expect(launcherWorktree.pickChoices(c, 100)[0].text).toBe("No branch matches");
  expect(c.takeFrom()).toBe(false);
  c.search(from => from.key(127));
  expect(c.takeFrom()).toBe(true);
  expect([c.base, c.focus]).toEqual([{ ref: "refs/heads/topic", name: "topic" }, "branch"]);
  expect(c.accept(snapshot, "/src/app-topic", default_template)).toBe(true);
  expect(c.planned).toEqual({
    branch: "login",
    base: "refs/heads/topic",
    base_name: "topic",
    path: "/src/app/.worktrees/login",
  });
  expect(c.mode).toBe("closed");
});

test("names Git won't take, or a branch checked out already, stay in the form", () => {
  for (const name of ["", "a b", "a..b", "-a", "a/", "a.lock", ".a", "a/.b", "a~1", "a:b"])
    expect(launcherWorktree.branchProblem(snapshot, name)).not.toBeNull();
  expect(launcherWorktree.branchProblem(snapshot, "topic")).toBe("topic is checked out already");
  expect(launcherWorktree.branchProblem(snapshot, "feat/login-2")).toBeNull();
});
