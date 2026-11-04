# Resolve a merge conflict in a custom corgi build

The custom build tool is rebuilding a corgi branch from upstream plus a list of
patches, merged one after another. Merging the next patch conflicted, and the
merge is in progress in this checkout (the current directory).

- Patch: {{patch}}
- Description: {{description}}
- Pull request: {{prLink}}
- Upstream: {{upstream}}

Patches merged before this one:

{{mergedSoFar}}

Conflicted files:

{{files}}

## What to do

Resolve the conflicts in the files listed above. Keep the intent of both
sides: the code already on the branch (upstream plus the patches merged
before) and the incoming patch. Remove every conflict marker (`<<<<<<<`,
`=======`, `>>>>>>>`). Read the surrounding code, the patch's own commits
(`git log -p MERGE_HEAD --not HEAD`) and the PR description when the right
combination isn't obvious.

## Rules

- Edit only the listed files. Do not touch any other file; changes the build
  needs elsewhere are handled in a later step.
- Do not commit, and do not run git commands that change refs or the index
  (`commit`, `merge`, `rebase`, `reset`, `checkout`, `stash`, `add`). The tool
  checks your result, stages it and commits the merge itself.
- Do not touch `.custom-build/` or any patch branch.
- When you are done, stop. Say briefly how you resolved each file.
