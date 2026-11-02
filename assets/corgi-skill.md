---
name: corgi
description: Control Corgi terminal panes, tabs, agents, and workspaces when the user asks to use Corgi. Discover layout, arrange running terminals, read output, and send input through its CLI.
---

# Corgi

Corgi organizes a persistent runtime into workspaces, tabs, and panes. Panes own
running terminals; tabs hold split trees. Each attached viewer owns its selection.

## Customize Corgi with Tricks

For account colors, sidebar additions, agent popovers, pane decorations or small
interactive overlays, run `corgi --skill tricks` for the bundled authoring API.
Tricks are JavaScript or TypeScript programs using `register(on, corgi)`.
Manage installed tricks and reload-on-save in Settings → Tricks;
`corgi tricks list --json` reports their folder, status and errors.

## Discover before acting

Run `corgi --help`, then `corgi list`. `corgi tab` and `corgi pane` print usage
without making changes. Never run bare `corgi` for discovery: it attaches the UI.
The installed binary is the authority for syntax. The runtime must already be
running; new agent commands never start, upgrade, or restart it implicitly.

`corgi list` outlines each workspace's tabs and their panes, with each pane's
agent and state, then the attached viewers:

```
workspace 2 "Corgi" /home/me/corgi
  tab 20 "Backend": 31 left of (42 above 43)
    pane 31 claude working "Fix the parser" (used: Bash)
```

Commands print text. Add `--json` for the daemon's full reply, such as the whole
`list` snapshot, for `jq`.

Use IDs from results, never tab positions or example IDs. IDs are scoped to the
runtime selected by `CORGI_SOCKET`. Pane IDs survive moves between workspaces.
`current` resolves the calling pane through `CORGI_PANE`, never a viewer's focus.
`corgi current` prints the calling pane's pane, tab and workspace IDs.
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
Creating a tab or split prints the new pane with its tab and workspace.
New terminals inherit the caller/target cwd, falling back to the destination
workspace folder; `--cwd` overrides it. `--command SHELL_COMMAND` launches a command
in a new tab or split. Existing terminals keep their cwd.

To reuse a terminal instead of opening another, `corgi pane idle --cwd DIR
--first` prints a pane whose shell waits at its prompt in that folder, by
workspace then tab; without `--first` it prints every one, and `--workspace`
narrows them. A shell running a command, editor or agent is not idle.

Layout changes do not focus a viewer. If the user asks to switch, discover the
viewer ID, then use `corgi focus 31 --viewer 1`. Do not guess which viewer belongs
to the user. Selection is preserved where its tab and pane still exist; removing
a selected tab requires the viewer to choose a surviving location.

## Read and send

```sh
corgi pane read 31 --lines 100
corgi pane send 31 'literal text'
corgi pane send 31 'command or prompt' --enter
corgi pane send 31 --stdin --enter < /path/to/prompt.txt
corgi pane keys 31 ctrl+c
corgi pane keys 31 esc
```

Read prints recent active-screen text, including available scrollback, with
soft wraps joined, headed by a `[corgi: …]` line when earlier lines exist.
Alternate-screen application history may not be available. For an agent it
trims line ends, shortens rules and collapses blank runs; pass `--no-agent` to
read the text as the screen shows it.
Send honors bracketed paste and optionally appends encoded Enter. Keys honor the
terminal's keyboard protocol; all keys are validated before any bytes are sent.
Use `--` before text beginning with `--`. Input delivery is not proof an agent
started or completed a turn. Inspect output and reported state; never blindly
resubmit after a timeout or connection error.

## Launcher agents

`corgi launcher list` outlines each workspace's launcher: every agent, account
and saved command it offers, and whether it's shown there. `hide` and `show`
change one workspace's launcher, the calling pane's unless `--workspace` names
another:

```sh
corgi launcher list --workspace 2
corgi launcher hide codex claude/work
corgi launcher show review-bot --workspace 2
```

Name agents as `list` does: `codex`, `claude`, an account such as `claude/work`
(or `work` when unambiguous), `profile/ID`, a clone's name, a saved command's
name, or `command/N`. Showing a globally hidden entry also restores it to the
shared catalog, matching Manage agents.

Manage agent setups without launching processes:

```sh
corgi launcher models codex --json
corgi launcher clone codex --name Reviewer --model MODEL_ID --effort high --workspace 2
corgi launcher edit Reviewer --model auto --effort default --workspace 2
corgi launcher edit Reviewer --flags '--verbose' --env '{"REVIEW":"1"}' --yolo off --workspace 2
corgi launcher move Reviewer --before codex --workspace 2
corgi launcher copy --from 2 --workspace 3
corgi launcher add --name Checks --command 'bun test' --workspace 2
corgi launcher remove Reviewer --workspace 2
```

`models` reports the native catalog, supported efforts and known defaults.
`auto` leaves the model to the agent CLI's last choice; `default` removes the
effort override. `--env` replaces environment overrides (`{}` clears them).
Native entries and clones support name, model, effort, flags, environment and
YOLO settings. Saved commands support name and `--command`.

`move` accepts `--before`, `--after`, `--first`, or appends without a position.
`copy` replaces the destination workspace's order and Active/Hidden choices.
Agent definitions and model settings are shared across workspaces, so editing
a named entry affects every workspace using it; clone it for independent settings.
`remove` deletes a clone or saved command globally. Hide native accounts instead.
None of these operations launch, move or terminate running agents.

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

Errors go to stderr as `corgi: NAME`, or as JSON with `ok:false` and `err`
under `--json`; a usage error lists the command's usage lines. Usage errors
exit 2, runtime errors exit 1. No automatic retries of mutations.
A broken connection can occur after a successful mutation: rediscover first.
