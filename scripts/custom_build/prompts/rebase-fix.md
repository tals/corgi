# Make a rebased patch branch pass its checks

The custom build tool rebased {{branch}}, one of the user's own patch branches,
onto the latest upstream main (the current directory has it checked out). The
rebase went through, but a check now fails on the rebased branch: upstream
changed something the branch relies on, or added something it collides with.

- Patch: {{patch}}
- Description: {{description}}
- Branch: {{branch}}
- Upstream: {{upstream}}
- Check: {{step}}
- Command: `{{command}}`
- What fails: {{failing}}
- Attempt: {{attempt}}

The end of the check's output:

```text
{{logExcerpt}}
```

## What to do

Find why the check fails on the rebased branch and change the branch's code so
it passes on top of the new upstream, keeping the branch's intent. Adapt the
branch to upstream; don't undo upstream's changes. `git log -p {{base}}..HEAD`
shows what the branch adds, `git log --oneline {{from}}..{{base}}` what
upstream added since the branch was last rebased. Run the command above (or
only the failing test files) to check your fix.

## Rules

- Leave your changes in the working tree. Do not commit, amend, rebase, push
  or switch branches; the tool commits your change as a separate fix commit on
  the branch, and the user reviews it before anything is pushed.
- Do not edit `.custom-build/`.
- When you are done, stop. Say briefly what was wrong and what you changed.
