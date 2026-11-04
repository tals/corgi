# Custom builds

`scripts/custom-build` builds a corgi of your own: upstream `main` plus the
patches you choose, such as your branches, open PRs on `tals/corgi`, and PRs or
branches on other people's forks. One `rebuild` fetches everything, resets a
`custom-build` branch to upstream, merges the patches in order, runs the
repository's checks and writes `dist/corgi-custom`. The regular `dist/corgi`
and an installed release are left alone.

The binary says what it carries. `dist/corgi-custom --version --verbose` and
bug reports add the repository of your fork and one line per patch: its merge
commit and the subject `Merge <source>: <description>`, in merge order.

```
corgi 0.1.0-dev (6170222f76c06e8813d60a029e24f96676290dd9)
  github.com/you/corgi
  2b8e0f1 Merge tals/corgi#109: Keep blocked agents as jump-to-attention targets
  9c41d7a Merge my-branch: Section tint
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
name ends up in the binary, the bug report, commit messages and prompts. Use a
git credential helper instead.

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
| `add <source> [--description <text>]` | Appends a patch. Duplicates are refused. |
| `remove <source> [--reason <text>]` | Moves a patch to the retired list. Asks for a reason on a terminal. |
| `list [--retired]` | Shows the patches in merge order, or the retired ones. |
| `rebuild [--push]` | Runs the whole rebuild. `--push` then force-pushes the custom branch to `origin` with a lease. |
| `continue` | Resumes a stopped run after you resolved the conflict or fixed the step. |
| `rollback` | Returns to the last successful build. |
| `status` | Shows a stopped run and which patches need a rebase onto upstream. |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 1 | usage or precondition error: dirty tree, a run already stopped, git too old, fetch failure |
| 2 | stopped at a merge conflict |
| 3 | stopped at a failing step |
| 4 | the step fails on plain upstream too: upstream is broken |
| 5 | the harness ran out of attempts |

Progress goes to stderr, prefixed `custom-build:`; the summary goes to stdout.

## A rebuild

1. Refuses to start with uncommitted changes to tracked files or with a run
   already stopped.
2. Fetches upstream and every patch. A patch that can't be fetched stops the
   run here, before anything changed.
3. Skips PRs merged upstream (the report says they can be removed) and patches
   already contained in the branch. A PR closed without merging is still
   merged, with a warning.
4. Resets the custom branch to upstream `main` and merges each patch with
   `--no-ff` as `Merge <source>: <description>`. Conflict resolutions you made
   before replay through rerere.
5. Runs `bun install --frozen-lockfile` when `bun.lock` or `package.json`
   changed, then `bun typecheck.ts`, `bun test src` and
   `bun build.ts --outfile dist/corgi-custom`, which stamps the merges since
   upstream `main` into the binary.
6. When a step fails, runs it on plain upstream in a throwaway worktree first.
   If upstream fails too, the run stops with exit 4 and blames nobody.
7. On success, keeps the build the run started from as `custom-build-prev`
   and `dist/corgi-custom.prev`, then runs the after-build command if there is
   one.

A stopped run leaves its state in place with the custom branch checked out:
resolve the conflict and `git add` the files, or fix the step (commit it or
leave it in the tree, which `continue` commits as a user fix), then run
`continue`. If the run was interrupted while the harness was working,
`continue` first checks what the harness left the same way it checks a finished
result: accepted, it is committed as the agent's; rejected, the run stops with
the conflict or failing step in place. `rollback` instead returns to where the
run started. Without a
stopped run, `rollback` restores `custom-build-prev` and
`dist/corgi-custom.prev`.

The tool copies itself into the config directory at the start of a run, so
`continue`, `rollback` and `status` work even when upstream doesn't have the
tool yet. A stop prints the `bun .../work/tool/main.ts` command for that case.

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
    "timeoutSeconds": 900,
    "attempts": 3
  },
  "afterBuild": ["./dist/corgi-custom", "dev"]
}
```

- `upstream.remote` defaults to `upstream` when that remote exists, else
  `origin`. `upstream.branch` defaults to `main`.
- `branch` defaults to `custom-build`.
- `harness` and `afterBuild` are optional. `afterBuild` runs in the repository
  root after a fully successful run; if it fails, the build still counts. The
  example hot-reloads a running corgi from the new binary.

## Agent harness

Without a harness, a conflict or a failing step stops the run for you. With
one, the run goes on unattended. The tool fills a prompt from
`scripts/custom_build/prompts/`, writes it to the run's `prompts/` directory,
replaces `{prompt_file}` in the command with its path, and also pipes it on
stdin. The command runs in the repository root with `CORGI_CUSTOM_BUILD_KIND`
(`conflict` or `build`) and `CORGI_CUSTOM_BUILD_PROMPT` set. The command alone
decides what the harness may do; give it a tool list like the one above.
Allowing it to run the tests lets it run any code it writes, and its prompts
carry PR descriptions and step output from the patches.

The tool checks every result itself; the harness's exit code doesn't count.

- **Conflicts:** accepted when no conflict markers remain, only the conflicted
  files changed and nothing was committed. The merge is committed with a
  `Resolved-By: harness` trailer. A rejected attempt is undone and retried.
- **Failing steps:** called only when the step passes on plain upstream. Its
  changes become a separate `custom-build: fix <step> (agent)` commit with a
  `Fixed-By: harness` trailer, then the step and the ones after it rerun.

Each call is limited to `timeoutSeconds` (default 900) and each problem to
`attempts` calls (default 3); running out stops the run with exit 5. A harness
that isn't executable is reported as a warning, and the run behaves as without
one. Fix
commits are never carried into the next rebuild: the problem comes back until
the patch itself is fixed.

## Reports and handoffs

Every run writes `reports/<UTC timestamp>/` in the config directory, with
`reports/latest` pointing at the newest; the last 10 runs are kept. A run
directory holds:

- `report.md`: upstream commits pulled in; merged, skipped and contained
  patches; agent-resolved merges and fix commits; each step's result; the
  patches that need a rebase; clashes between patches; handoffs written; how
  to roll back.
- `handoffs/<patch>.md`: a problem to fix in a patch's own branch, with a
  ready-to-run prompt for that checkout.
- `steps/` and `prompts/`: step logs, harness prompts and harness output.

At the end of every run each patch is test-merged alone onto upstream without
touching the working tree. One that conflicts gets a `rebase` handoff. After an
agent build fix, the step runs again for each implicated patch merged alone
onto upstream: a patch that fails alone gets a `build-drift` handoff; if none
does, each implicated patch gets a `build-clash` handoff naming the others.
Conflicts between two patches that are each clean against upstream are only
noted in the report.

## What it never touches

The tool never rebases, amends or pushes patch branches, never pushes to
upstream and never adds remotes. It changes only the custom branch,
`<branch>-prev`, `refs/custom-build/*`, `dist/corgi-custom*` and the config
directory, plus what fetching and merging update anyway: the remote-tracking
refs it fetches (`<upstream remote>/main`, `origin/<branch>` for own branches),
the rerere cache, throwaway worktrees under the config directory, and one line
in `.git/info/exclude` that keeps the config directory out of `git status`. It never restarts a running corgi unless `afterBuild` says to.
