# Worktree overview

Open Corgi at the project root. A workspace with linked Git worktrees shows an
`N worktrees` count in its status row, including worktrees with no agents. Hover
to compare them in a callout connected to the count. Arrows or the wheel browse
without dismissing it; Enter or clicking a worktree focuses its agents.
Press Escape to close. `corgi action worktrees` opens the current workspace's
table; an optional workspace ID selects another workspace.
Paths inside the workspace use `./`; other paths inside the home directory use `~/`.

The primary checkout is the reference context and is excluded from the count.
No worktree is required, created, moved, removed or merged by this feature.
The existing unpushed-commit badge still compares with the branch's upstream.

## Local data

`trackers/worktrees.ts` discovers registered checkouts with NUL-delimited Git
porcelain, including paths outside the project. It retains detached, locked and
prunable entries. Missing, prunable checkouts are hidden from the count and table
and skipped for detail scans. Locked checkouts and unavailable checkouts without
a prunable marker remain visible. Git metadata is never pruned.
The comparison branch is the local counterpart of
`origin/HEAD`, then local `main`, `master`, or `trunk`. With no matching branch,
the comparison remains unavailable. There is no fetch or GitHub request.

Ahead and behind count commits on the two sides of the comparison. “Included
in main” means Git proves that the checkout's HEAD is reachable from local
main. It does not infer squash merges. The table shows local changed-file counts
from Git status. The underlying snapshot retains separate staged, unstaged,
untracked and conflicted counts.

Agent membership resolves checkout roots from observed working directories and
successful structured edits. Reads do not change membership. Claude edit hooks
and Codex completed file-change items supply edit evidence; arbitrary shell
commands do not. The most recent successful edit determines membership. A single
edit operation spanning checkouts can associate one agent with more than one row;
a later edit in one checkout moves membership there. Missing metadata retains
the last association as uncertain.

## Cost and lifetime

The daemon shares inventory by Git common directory and refreshes it every ten
seconds. It caches non-repositories for thirty seconds. Comparisons are cached
by the two commit hashes; local status is scanned at most every three seconds
while a watched viewer has the table open. Subprocesses have time and output
bounds. Failures retain known data with a stale marker rather than reporting
an empty or clean checkout.

Snapshots expose optional `workspaces[].worktrees`; viewers request details
through optional `viewer.sync.worktree_detail`. These additive, defaulted fields
keep protocol 1 and viewer protocol 3. Checkpoints and handoffs are unchanged:
Git data and current edit evidence are disposable and rediscovered after restart.

The agent sidebar keeps its regular list. Live agents in linked worktrees appear
under checkout headings; primary-checkout agents stay direct rows. In "All",
checkout headings branch off their workspace's rail. Clicking a heading folds
its group; right-clicking it offers Fold and "Close all agents for", which
closes the group's agents that run in panes. While the list is scrolled into a
group, its workspace and checkout headings stay pinned above it. Browsing an
existing group scrolls it into view. A worktree absent from the list appears as
a temporary group at the top, fading in inside a dashed outline with normal
branch and agent text, showing three recent sessions from the existing launcher
history when no agents are active, plus an expandable `… more` row. Enter or
clicking the worktree keeps the group in the sidebar and focuses its first live
agent, or its heading when only recent sessions remain. Clicking a recent
session resumes it through the existing launcher path.

Recent-session membership uses recorded working directories, not a reconstructed
edit history. These sidebar additions are viewer-local. Summary generation,
stored summaries and work history remain deferred; the table has no detail or
summary section.
