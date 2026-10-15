---
name: corgi
description: Control Corgi terminal panes, tabs, agents, and workspaces when the user asks to use Corgi. Discover layout, arrange running terminals, read output, and send input through its CLI.
---

# Corgi

Corgi organizes a persistent runtime into workspaces, tabs, and panes. Panes own
running terminals; tabs hold split trees. Each attached viewer owns its selection.

## Discover before acting

Run `corgi --help`, then `corgi list`. `corgi tab` and `corgi pane` print usage
without making changes. Never run bare `corgi` for discovery: it attaches the UI.
The installed binary is the authority for syntax. The runtime must already be
running; new agent commands never start, upgrade, or restart it implicitly.

`corgi list` returns JSON: `.result.workspaces[].tabs[]` holds names and split
trees; `.result.panes[]` holds IDs, location, cwd, PID, and agent observations;
`.viewers[]` identifies attached viewers. `--text` pretty-prints discovery JSON.

Use IDs from results, never tab positions or example IDs. IDs are scoped to the
runtime selected by `CORGI_SOCKET`. Pane IDs survive moves between workspaces.
`current` resolves the calling pane through `CORGI_PANE`, never a viewer's focus.
`corgi current` returns its current `.result.pane`, `.tab`, and `.workspace`.
Outside a managed pane, use explicit IDs and `--workspace` for tab creation.

## Arrange terminals

```sh
corgi tab new --name Tests --cwd /absolute/project/path
corgi tab rename current Backend
corgi tab rename 12 --clear
corgi tab move 12 --before 8
corgi tab move 12 --after 8
corgi tab move 12 --workspace 2
corgi pane split current --right
corgi pane split 31 --down --cwd /absolute/project/path
corgi pane move 31 --right-of 42
corgi pane move 31 --below 42
corgi pane move 31 --new-tab --name Logs
corgi pane swap 31 42
corgi pane resize 31 --width 60%
corgi tab merge 12 --right-of 42
```

Left/up directions are also supported. Resize sets the target's side to a share
of its nearest split on the specified axis (10%-90%); nested panes on that side
share the resized region. An absent matching split is an error.

Tab merge moves the entire source split tree beside the target pane, preserving
its internal geometry. The source tab disappears. Moving the last pane out also
removes its empty tab. Moves preserve processes, terminal output, and pane IDs.
Creating a tab or split returns `.result.pane`, `.result.tab`, `.result.workspace`.
New terminals inherit the caller/target cwd, falling back to the destination
workspace folder; `--cwd` overrides it. `--command SHELL_COMMAND` launches a command
in a new tab or split. Existing terminals keep their cwd.

Layout changes do not focus a viewer. If the user asks to switch, discover the
viewer ID, then use `corgi focus 31 --viewer 1`. Do not guess which viewer belongs
to the user. Selection is preserved where its tab and pane still exist; removing
a selected tab requires the viewer to choose a surviving location.

## Read and send

```sh
corgi pane read 31 --lines 100 --text
corgi pane send 31 'literal text'
corgi pane send 31 'command or prompt' --enter
corgi pane send 31 --stdin --enter < /path/to/prompt.txt
corgi pane keys 31 ctrl+c
corgi pane keys 31 esc
```

Read returns `.result.text`, containing recent active-screen text, including available scrollback, with
soft wraps joined. Alternate-screen application history may not be available.
Default read output is JSON with `.text`; `--text` emits just that text.
Send honors bracketed paste and optionally appends encoded Enter. Keys honor the
terminal's keyboard protocol; all keys are validated before any bytes are sent.
Use `--` before text beginning with `--`. Input delivery is not proof an agent
started or completed a turn. Inspect output and reported state; never blindly
resubmit after a timeout or connection error.

## Scope and safety

Only send input to agents or terminals when the user's task authorizes it.
Inspect the terminal before typing; it may contain a shell, editor, agent,
approval dialog, or running process. Do not answer approvals on the user's behalf
without authorization. Prefer existing topology unless asked to create more.

`corgi pane close ID` and `corgi tab close ID` terminate the contained processes.
Do not close user work unless explicitly requested. These commands do not prompt.
Existing `corgi workspace` commands manage workspace metadata; use its help.
Do not stop/restart the runtime to obtain a missing command. Ask the user about
updating when the server does not support this CLI.

Success is JSON on stdout. Errors are JSON on stderr with `ok:false` and `err`
(a `Usage` error adds the command's `usage` lines); usage errors exit 2,
runtime errors exit 1. No automatic retries of mutations.
A broken connection can occur after a successful mutation: rediscover first.
