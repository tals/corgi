# Fix a failing step in a custom corgi build

The custom build tool rebuilt this checkout from upstream plus a list of
patches, and a verification step fails on it. The same step passes on plain
upstream, so the failure comes from the patches or from how they combine. All
merges are committed; the run is stopped until the step passes.

- Step: {{step}}
- Command: `{{command}}`
- Cause: {{cause}}

Patches merged in this run:

{{patches}}

The end of the step's output (the full log is {{log}}):

```text
{{logExcerpt}}
```

## What to do

Find why the step fails and change only what is needed to make it pass. Run
the command above until it passes. Prefer the smallest change that keeps every
patch's intent; this fix applies to this custom build only, and the patches'
authors get handoffs for the lasting fix.

## Rules

- Leave your changes in the working tree. Do not commit, amend or rebase.
- Do not edit `.custom-build/` or any patch branch.
- Do not run `scripts/custom-build` yourself. When the command passes, stop
  and say briefly what was wrong and what you changed; the user then runs
  `scripts/custom-build continue`, which commits the fix and verifies the
  build again.
