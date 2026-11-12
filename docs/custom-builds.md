# Custom builds

`scripts/custom-build` builds a corgi of your own: upstream `main` plus the
patches you choose, such as your branches, open PRs on `tals/corgi`, and PRs or
branches on other people's forks. One `rebuild` fetches everything, resets a
`custom-build` branch to upstream, merges the patches in order, runs the
repository's checks and writes `dist/corgi-custom`. The regular `dist/corgi`
and an installed release are left alone.

The binary says where it comes from. `dist/corgi-custom --version --verbose`
and bug reports name the repository of your fork, as an https link.

```
corgi 0.1.0-dev (6170222f76c06e8813d60a029e24f96676290dd9)
  https://github.com/you/corgi
```

The plain `--version` line is the same as for any development build, and
`corgi update` refuses it like one.

## Prerequisites

- Bun and a corgi clone, with `tals/corgi` as the `upstream` remote (or as
  `origin` when you have no fork).
- git 2.38 or newer.
- Optional: the GitHub CLI (`gh`), signed in. It supplies PR titles and tells
  merged PRs apart. Without it, a PR counts as merged once its head is in
  upstream, and `add` needs `--description`.
- Optional: an agent harness command for unattended runs (below).

## Quick start

```sh
scripts/custom-build add 109                 # an upstream PR; its title is the description
scripts/custom-build add rhuss/corgi#2       # a PR on a fork
scripts/custom-build add my-branch --description "Section tint"
scripts/custom-build list
scripts/custom-build rebuild
./dist/corgi-custom --version --verbose
```

## Patch sources

| You write | Patch |
| --- | --- |
| `#123`, `123`, `https://github.com/tals/corgi/pull/123` | upstream PR |
| `owner/repo#12`, `https://github.com/owner/repo/pull/12` | PR on another repository |
| `owner/repo:branch`, `https://github.com/owner/repo/tree/branch` | branch on another repository |
| `<git url>#branch=<name>` | branch in any git repository |
| anything else | branch of your own repository |

PRs are fetched from GitHub's `refs/pull/<N>/head`, so fork PRs need no
remote. Fetched refs live under `refs/custom-build/` and never show up in
`git branch`. An own branch uses the local one, or `origin/<branch>` when the
local one is missing or behind; when the two have diverged the local one wins
and the report says so.

A git URL must not carry credentials (`https://user:token@...`): the source
name ends up in the config, reports, handoffs, commit messages and prompts. Use
a git credential helper instead.

Every patch is code that runs as you: each rebuild fetches the PR's or
branch's current head and runs `bun install`, the tests and the build with
your environment. Add only patches whose authors you trust, and look at what
changed since the last rebuild when in doubt.

## Commands

```
scripts/custom-build [--dir <path>] <command> [args]
```

| Command | Effect |
| --- | --- |
| `add <source> [--description <text>]` | Appends a patch. Duplicates, the custom branch and its `-prev` backup are refused. |
| `remove <source> [--reason <text>]` | Moves a patch to the retired list. Asks for a reason on a terminal. |
| `list [--retired]` | Shows the patches in merge order, or the retired ones, as a table. On a terminal each patch links to its PR or branch page (OSC 8, for example in Ghostty, iTerm2, WezTerm or kitty). |
| `rebuild [--rebase=<mode>] [--push] [--in-worktree] [--verbose]` | Runs the whole rebuild, rebasing your own branches first. `--push` then force-pushes the custom branch and the rebased branches to `origin` with a lease. |
| `rebase [--rebase=<mode>] [--push] [--in-worktree] [--verbose]` | Only rebases your own branches onto upstream (below). |
| `rebase --skip-branch [--verbose]` | Gives up the branch a stopped `rebase` run is at, and goes on with the next. |
| `continue [--verbose]` | Resumes a stopped run after you resolved the conflict or fixed the step. |
| `rollback [--verbose]` | Returns to the last successful build. |
| `status` | Shows a stopped run, which patches need a rebase onto upstream, and which of your own branches `rebase` would update, leaves alone (with the reason, such as the worktree it is checked out in), or has rebased without pushing. |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 1 | usage or precondition error: dirty tree, a run already stopped, git too old, fetch failure; also a run that finished but whose push of a rebased branch was refused |
| 2 | stopped at a merge conflict, or a rebase conflict in `rebase` |
| 3 | stopped at a failing step |
| 4 | the step fails on plain upstream too: upstream is broken |
| 5 | the harness ran out of attempts, or failed to start |

Progress goes to stderr, prefixed `custom-build:`; the summary goes to stdout.
On a terminal, `rebuild`, `rebase` and `continue` show a
[live view](#live-view) instead. Ctrl-C stops the tool at once with exit 130,
even in the middle of a git call, and the live view leaves the terminal as it
found it.

## A rebuild

1. Refuses to start with uncommitted changes to tracked files or with a run
   already stopped.
2. Fetches upstream and every patch. A patch that can't be fetched stops the
   run here, before anything changed. Then rebases your own branches that are
   behind upstream (see [Rebasing your own branches](#rebasing-your-own-branches));
   this never stops the rebuild.
3. Skips PRs merged upstream (the report says they can be removed) and patches
   already contained in the branch. A PR counts as merged upstream once the
   fetched `main` contains its merge commit; one merged elsewhere is merged with
   a note. A PR closed without merging is still merged, with a warning. The
   custom branch and its `-prev` backup can't be patches themselves.
4. Resets the custom branch to upstream `main` and merges each patch with
   `--no-ff` as `Merge <source>: <description>`. Conflict resolutions you made
   before replay through rerere.
5. Runs `bun install --frozen-lockfile` when nothing is installed yet or
   `bun.lock` or `package.json` changed, then `bun typecheck.ts`, `bun test src`
   (after `bun build.ts --native-only`, which the unit tests need) and
   `bun build.ts --outfile dist/corgi-custom`, which stamps the fork's
   repository into the binary.
6. When a step fails, runs it once more (for `test`, only the test files that
   failed; see `{tests}` below). If it passes then, the run goes on
   and the report warns that the step may be flaky. If it fails again, runs it
   on plain upstream in a throwaway worktree first. If upstream fails too, the
   run stops with exit 4 and blames nobody.
7. On success, keeps the build the run started from as `custom-build-prev`
   and `dist/corgi-custom.prev`, then runs the after-build command if there is
   one.

A stopped run leaves its state in place with the custom branch checked out:
resolve the conflict and `git add` the files, or fix the step (commit it or
leave it in the tree, which `continue` commits as a user fix), then run
`continue`. If the run was interrupted while the harness was working,
`continue` first checks what the harness left the same way it checks a finished
result: accepted, it is committed as the agent's; rejected, the run stops with
the conflict or failing step in place. After any fix, whether yours or the
harness's, every step runs again from the first, so a fix can't break a step
that passed before it. `rollback` instead returns to where the run started,
discarding what the run left on the custom branch, and reinstalls
dependencies for the restored tree; it refuses while another branch has
uncommitted changes, and leaves the stopped run as it was. If the reinstall
fails, `continue` finishes the rollback. Without a stopped run, `rollback`
restores `custom-build-prev` and `dist/corgi-custom.prev`.

The tool copies itself into the config directory at the start of a run, so
`continue`, `rollback` and `status` work even when upstream doesn't have the
tool yet. A stop prints the `bun .../work/tool/main.ts` command for that case.

## Rebasing your own branches

When upstream `main` moves, your own patch branches fall behind. The tool
rebases them onto upstream for you, inside every `rebuild` and on its own with
`rebase`. It only touches branches you own:

- own branches in the patch list (`my-branch`);
- PRs opened from your fork, the repository `origin` pushes to. Recognizing them
  needs `gh`; without it, only own branches count.

Branch tips, leases and pushes all use the URL `origin` pushes to, so a remote
that fetches from upstream and pushes to your fork works.

Other people's PRs and branches on other forks are never rebased; when they
conflict with upstream, they get a `rebase` handoff as before. If `origin` is
upstream itself, there is no fork to push to and nothing is rebased.

Which branches it rebases depends on the mode, from `"rebase"` in the config
or `--rebase=<mode>` for one run:

| Mode | Rebases |
| --- | --- |
| `all` (default) | every own branch behind upstream `main` |
| `conflicting` | only own branches that no longer merge cleanly onto upstream `main` |
| `off` | nothing |

For each branch:

1. Skips it when it is checked out in any worktree, or when the local branch
   and its pushed copy have diverged. A local branch behind its pushed copy
   starts from the pushed one; an own PR's branch that exists only on the fork
   gets a local branch. With `--in-worktree`, a branch checked out in a
   worktree is instead rebased right there (below); its push still due, or its
   checkout behind the pushed copy, keeps it skipped.
2. Rebases it onto upstream in a throwaway worktree under the config
   directory, never in your checkout. Recorded resolutions replay through
   rerere; other conflicts go to the harness, checked like merge conflicts.
3. Runs install, typecheck and tests on the rebased branch alone, with the
   same retry for flaky failures (a check that passed only the second time is
   reported as possibly flaky). When a check still fails, the harness gets
   up to `attempts` tries per branch to adapt the branch to upstream; an
   accepted change becomes a `fix: pass <check> on upstream <sha>` commit on
   the branch with a `Fixed-By: harness` trailer, and every check runs again.
   The result line names that commit for review; it is pushed only with the
   branch, after the usual question. A branch whose checks still fail is not
   rebased, and the line says what fails, such as
   `test fails on the rebased branch: 2 tests fail in src/bindings.test.ts (…)`.
4. Only when they pass, and only if nobody checked out or moved the branch
   meanwhile, moves the branch to its new tip and, in the same step, keeps the
   tip it rebased as `refs/custom-build/rebase-backup/<branch>` until the branch
   is pushed: `git branch -f <branch> refs/custom-build/rebase-backup/<branch>`
   undoes it (`git branch -D <branch>` for a branch the tool created). A rebase
   that leaves no commits on top of upstream doesn't move the branch, and the
   report suggests removing the patch.

With `--in-worktree`, a branch checked out in a worktree of yours is rebased
inside that worktree, so the checkout moves with its branch instead of being
left behind; git keeps the two in step itself. Such a rebase needs the
worktree's tracked files committed (uncommitted ones skip the branch), and the
checks of step 3 run in your worktree. Because the rebase itself moves the
branch, its backup of step 4 is kept from the rebase's start, so an
interruption during the checks undoes like any other rebase. A rebase or check
that fails, or one that leaves no commits, resets the branch back to the tip it
started from, and the worktree is never removed. A conflict the harness can't
resolve stops there
as usual: resolve it in your worktree and run `continue`.

Inside `rebuild`, a branch that can't be rebased or fails its checks keeps its
old tip, gets a `rebase` or `rebase-checks` handoff, and is merged as it is. The
`rebase` command instead stops at a conflict it can't resolve, with exit 2 (5
when the harness ran out of attempts) and the worktree path: resolve the
conflict there, `git add` the files and run `continue`; or run
`rebase --skip-branch`; or `rollback` to end the run. Branches rebased before
the stop keep their new tips; `rollback` lists them with their push commands.

At the end of a successful run, the tool lists the branches it moved. On a
terminal it asks whether to force-push them to `origin`; `--push` pushes without
asking; otherwise it prints the push command for each. Every push uses
`--force-with-lease` against the tip it fetched, so a branch someone pushed to
in the meantime is refused, not overwritten, and keeps its backup; git's full
output goes to the report's `rebase/` directory, and the retry command is
printed. A branch you don't push stays "rebased, push pending": later runs offer
the push again (and `status` shows its command), and rebase it again from its
new tip when upstream moves on.

## Live view

When stdout is a terminal, `NO_COLOR` is unset and `TERM` isn't `dumb`,
`rebuild`, `rebase` (with `--skip-branch` too) and `continue` show a live view
in place of the progress lines and step output:

- the command, the custom branch, and the upstream tip with its count of new
  commits;
- a timeline bar with one colored segment per stage, the elapsed time and the
  estimate, and under it the bar of the last finished run;
- one line per stage; the running stage lists its patches, branches or steps
  with their outcome, try number and clock;
- the harness calls with their tokens (with a `kind`), the retries, and,
  without `--verbose`, one dim line with the latest harness activity or step
  output.

Long text wraps instead of being cut: an outcome or a stage's list continues
on up to three lines under itself (the list says `+3 more` past that), the
activity line on up to two. A view taller than the terminal keeps the header,
the timeline, the stage lines and the footer: the running stage folds the
patches before and after the one it is at into `✓ 4 done` and `· 3 pending`
lines. A resize lays the view out again at the new size. A terminal made
shorter may push the top of the view into the scrollback before it is redrawn.

When the run ends, the view turns into a card that stays in the scrollback,
with everything the plain output prints (push commands, handoffs, notes, the
report) and its `warning:` lines. An error that ends the command shows on the
card too, on stdout, rather than on stderr. Patch names link to their pages and
steps to their logs (OSC 8).

`--verbose` pins the view at the top and scrolls the full log below it: the
`custom-build:` lines, step output and harness output (readable text with a
`kind`). The log takes the place of the dim activity line. On a terminal under
20 rows it is ignored, so the view keeps its footer. Piped output stays plain,
`--verbose` or not.

`rollback` on a terminal shows its steps as a checklist (undo, binary,
install) with a clock on the running one, and ends with a card. The install's
output goes only to its log; `rollback --verbose` shows it instead of the
checklist. Errors on a terminal end in a card too, in red: a refusal because a
run is stopped says where it stopped, since when, its report, and the commands
that go on from there (piped, these lines follow the error message).

The tab or dock shows the run's progress (OSC 9;4). A stop shows the error
state only briefly, while the stop's report is written: the card then puts the
terminal back, which clears the progress. A run that took more than 60 seconds
sends a desktop notification (OSC 9) when it finishes or stops, and every wait
on the y/N push question sends one.

Estimates come from `timings.json` in the config directory, which keeps the
last 20 finished runs; a rolled-back run isn't recorded, and of the harness
calls only accepted ones are. `rebuild` and `rebase` are estimated from their
own runs. An item still to do counts as the median of its last 5 durations;
an item never seen before, as the median of its stage's items in the last 5
runs. A duration more than three times the median of its peers and at least
5 minutes above it, like a step the computer slept through, is left out, and
the last run a run compares with is the latest without such a total. Only
active time counts, not the time a run sat stopped before `continue` or
waited for the push answer. A first run has no estimate and shows the
elapsed time only.

## Configuration

The config lives in `.custom-build/config.json` at the repository root, which
git ignores. `--dir <path>` or `CORGI_CUSTOM_BUILD_DIR` point elsewhere, for
example into a dotfiles repository (the option wins). Use one directory and
branch name per custom build. `add` and `remove` rewrite the file; you can also
edit it by hand.

```json
{
  "version": 1,
  "upstream": { "repo": "tals/corgi", "remote": "upstream", "branch": "main" },
  "branch": "custom-build",
  "patches": [
    { "source": { "kind": "pr", "repo": "tals/corgi", "number": 109 }, "description": "Jump to blocked agents", "added": "2026-11-04" },
    { "source": { "kind": "branch", "name": "my-branch" }, "description": "Section tint", "added": "2026-11-04" }
  ],
  "retired": [],
  "harness": {
    "command": [
      "claude", "-p",
      "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash(git diff:*),Bash(git status:*),Bash(bun typecheck.ts),Bash(bun test:*)"
    ],
    "kind": "claude",
    "timeoutSeconds": 900,
    "attempts": 3
  },
  "afterBuild": ["./dist/corgi-custom", "dev"],
  "rebase": "all"
}
```

- `upstream.remote` defaults to `upstream` when that remote exists, else
  `origin`. `upstream.branch` defaults to `main`.
- `branch` defaults to `custom-build`.
- `rebase` is optional: `all` (default), `conflicting` or `off`.
- `steps` is optional and overrides a step's command, such as
  `"test": ["sh", "-c", "bun build.ts --native-only && bun test {tests} --timeout 60000"]`.
  `{outfile}` is the binary to build. `{tests}` is `src`, or, when a test run
  is retried, the test files that failed; a command without it reruns
  everything. As a whole argument it becomes one argument per file.
- `harness.kind` is optional: `claude` or `codex` (see [Agent harness](#agent-harness)).
- `harness` and `afterBuild` are optional. `afterBuild` runs in the repository
  root after a fully successful run; if it fails, the build still counts. The
  example hot-reloads a running corgi from the new binary.

## Agent harness

Without a harness, a conflict or a failing step stops the run for you. With
one, the run goes on unattended. The tool fills a prompt from
`scripts/custom_build/prompts/`, writes it to the run's `prompts/` directory,
replaces `{prompt_file}` in the command with its path, and also pipes it on
stdin. The command runs in the repository root (for a conflict or a failing
check while rebasing an own branch, in the worktree it is rebased in) with `CORGI_CUSTOM_BUILD_KIND`
(`conflict` or `build`) and `CORGI_CUSTOM_BUILD_PROMPT` set. The command alone
decides what the harness may do; give it a tool list like the one above.
Allowing it to run the tests lets it run any code it writes, and its prompts
carry PR descriptions and step output from the patches.

Set `kind` to `claude` or `codex` when the command runs that agent; the tool
never guesses it from the command name. With a `kind`, the tool asks the agent
for a JSON event stream: for `claude` it appends
`--output-format stream-json --verbose` unless the command already has an
`--output-format`; for `codex` it adds `--json` right after `exec` (at the end
when there is no `exec`) unless the command already has `--json`. The readable
text, the agent's messages and tool calls, goes to the call's
`prompts/NN-<conflict|build>.log`, the raw stream to the `.jsonl` file beside
it. The tokens of each call go into the "Harness" section of `report.md` and
the live view, as in and out: for `claude`, in counts input, cache creation and
cache read tokens; for `codex`, in is its `input_tokens`, which already include
the cached ones. Without a `kind`, nothing is added to the command and its
tokens are unknown.

The tool checks every result itself; a harness that exits non-zero but leaves
an acceptable result is still accepted. A rejected call that exited non-zero
(an expired login, a bad flag) ends the attempts at once, since the next call
would fail the same way: the stop names the exit code and the harness's last
output line, and `continue` asks the harness again once it is fixed.

- **Conflicts:** accepted when no conflict markers remain, only the conflicted
  files changed and nothing was committed. The merge is committed with a
  `Resolved-By: harness` trailer. A rejected attempt is undone and retried.
- **Failing steps:** called only when the step passes on plain upstream. Its
  changes become a separate `custom-build: fix <step> (agent)` commit with a
  `Fixed-By: harness` trailer, then every step reruns from the first.

Each call is limited to `timeoutSeconds` (default 900) and each problem to
`attempts` calls (default 3); running out stops the run with exit 5. So that
fixes which keep breaking each other can't loop, a run also stops with exit 5
once the harness has made `attempts` × 4 fixes (one round per step) and a step
still fails. A harness
that isn't executable is reported as a warning, and the run behaves as without
one. Fix
commits are never carried into the next rebuild: the problem comes back until
the patch itself is fixed.

## Reports and handoffs

Every run writes `reports/<UTC timestamp>/` in the config directory, with
`reports/latest` pointing at the newest; the last 10 runs are kept, and so are
the logs of the last 10 rollbacks made without a stopped run
(`reports/rollback-<timestamp>/`). A run directory holds:

- `report.md`: upstream commits pulled in; rebased branches with their undo
  commands and push results; merged, skipped and contained patches; agent-resolved merges and fix commits; harness calls with their tokens; each step's result; the
  patches that need a rebase; clashes between patches; handoffs written; how
  to roll back.
- `handoffs/<patch>.md`: a problem to fix in a patch's own branch, with a
  ready-to-run prompt for that checkout.
- `fix-<step>.md`: for a run stopped at a failing step, a prompt for fixing it
  with an agent in the custom build's checkout. The stop prints it with the
  command that runs it there (the harness's executable, or `claude`), for
  example `cd ~/corgi && claude "$(cat …/fix-typecheck.md)"`; `continue`
  then commits the agent's changes as a user fix.
- `steps/`, `rebase/` and `prompts/`: step logs, the checks of rebased
  branches, harness prompts and harness output (plus the raw `.jsonl` stream
  with a `kind`).

At the end of every `rebuild`, stopped or not, each patch is test-merged alone onto upstream without
touching the working tree. One that conflicts gets a `rebase` handoff, and so
does an own branch whose rebase couldn't be completed; one whose checks failed
after the rebase gets a `rebase-checks` handoff. After an
agent build fix, or when the run stops at a failing step, the step runs again
for each implicated patch merged alone
onto upstream: a patch that fails alone gets a `build-drift` handoff; if none
does, each implicated patch gets a `build-clash` handoff naming the others (a
lone implicated patch names every other merged patch, since a clash needs two
sides). A patch that doesn't merge alone onto upstream can't be run that way
and counts toward a clash; its conflict gets its own `rebase` handoff. A stop
names the result as `caused by:`, and a user fix committed by `continue`
inherits it, so its handoffs show the fix. A
patch is implicated when it touches a file the fix changed or the failure
names; lines that hold only a path, like the file list of a test run, don't
count. When no patch is implicated, nothing runs and the report says the fix
has no handoff.
Conflicts between two patches that are each clean against upstream are only
noted in the report.

## What it never touches

The tool never amends patch branches, never rebases or pushes branches that
aren't your own, never pushes to upstream and never adds remotes. Your own
branches move only by a rebase whose checks passed, keep a backup until pushed,
and are pushed only after you said yes or passed `--push`. Besides them, it
changes only the custom branch, `<branch>-prev`, `refs/custom-build/*`,
`dist/corgi-custom*` and the config directory, plus what fetching and merging update anyway: the remote-tracking
refs it fetches (`<upstream remote>/main`, `origin/<branch>` for own branches),
the rerere cache, throwaway worktrees under the config directory, and one line
in `.git/info/exclude` that keeps the config directory out of `git status`. It never restarts a running corgi unless `afterBuild` says to.
