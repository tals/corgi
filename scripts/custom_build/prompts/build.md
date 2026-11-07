# Fix a failing step in a custom corgi build

The custom build tool rebuilt a corgi branch from upstream plus a list of
patches, and a verification step now fails on it. The same step passes on
plain upstream, so the failure comes from the patches or from how they combine.
This checkout (the current directory) has all merges committed.

- Step: {{step}}
- Command: `{{command}}`
- Attempt: {{attempt}}

Patches merged in this run:

{{patches}}

The end of the step's output:

```text
{{logExcerpt}}
```

## What to do

Find why the step fails and change only what is needed to make it pass. Run
the command above to check your fix. Prefer the smallest change that keeps
every patch's intent; this fix applies to this custom build only and is
reported back to the patches' authors.

## Rules

- Do not commit, amend or rebase; leave your changes in the working tree. The
  tool commits them as a separate fix commit.
- Do not edit `.custom-build/` or any patch branch.
- When you are done, stop. Say briefly what was wrong and what you changed.
