# Resolve a rebase conflict in a patch branch

The custom build tool is rebasing {{branch}}, one of the user's own patch
branches, onto the latest upstream main, in a throwaway worktree (the current
directory). Replaying one of the branch's commits conflicted, and the rebase is
stopped at that commit.

- Patch: {{patch}}
- Description: {{description}}
- Branch: {{branch}}
- Commit being replayed: {{commit}}
- Upstream: {{upstream}}

Conflicted files:

{{files}}

## What to do

Resolve the conflicts in the files listed above so the commit being replayed
applies on top of upstream main with its intent kept. Remove every conflict
marker (`<<<<<<<`, `=======`, `>>>>>>>`). `git show REBASE_HEAD` shows the
commit being replayed; `git log -p HEAD --not REBASE_HEAD` shows what upstream
changed.

## Rules

- Edit only the listed files. Do not touch any other file.
- Do not commit, and do not run git commands that change refs or the index
  (`commit`, `merge`, `rebase`, `reset`, `checkout`, `stash`, `add`). The tool
  checks your result, stages it and continues the rebase itself.
- When you are done, stop. Say briefly how you resolved each file.
