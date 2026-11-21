# Handoff: {{patch}}

- Kind: {{kind}}
- Patch: {{description}} ({{link}})
- Upstream: {{upstream}}

## Problem

{{problem}}

## Cause

{{cause}}

## Fix applied in the custom build

{{fix}}

## Prompt

Run this in the checkout of {{checkout}}:

> {{task}}
>
> Changes go into this PR branch, never into the custom build branch, which is
> regenerated on every rebuild. Commit the fix on {{checkout}} and push it so
> the PR picks it up.
