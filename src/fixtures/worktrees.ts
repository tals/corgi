import type * as worktrees from "../worktrees";

/** `branch` checked out at `path`, with `changes` uncommitted files, or null when unread. */
export function checkout(
  path: string,
  branch: string,
  primary = false,
  changes: number | null = null,
): worktrees.Checkout {
  return {
    path,
    head: "4f1c2a9e0b",
    branch: `refs/heads/${branch}`,
    primary,
    bare: false,
    detached: false,
    locked: null,
    holder: null,
    prunable: null,
    available: true,
    comparison: null,
    changes:
      changes === null
        ? null
        : { total: changes, staged: 0, modified: changes, untracked: 0, conflicted: 0, added: 0, removed: 0 },
    created: null,
    edited: null,
    stale: false,
  };
}

/** /src/app on main, with a topic worktree at /src/app-topic, and where `agents` work. */
export function app(agents: worktrees.Association[] = []): worktrees.Snapshot {
  return {
    common_dir: "/src/app/.git",
    base: { ref: "refs/heads/main", name: "main", head: "4f1c2a9e0b" },
    entries: [checkout("/src/app", "main", true), checkout("/src/app-topic", "topic")],
    agents,
    stale: false,
  };
}
