# Onboarding and shortcut presets

Run **`corgi onboard`** to open the wizard explicitly. From the repository, use
`./go.sh onboard`. Inside a Corgi pane it opens in that pane's viewer; outside
Corgi it starts or attaches to the selected runtime and opens onboarding there.
An already open wizard keeps its current state, including any active import.
You can also reopen it from **Corgi setup → Shortcuts & import**.

Automatic onboarding appears until setup is completed once for the current user
on this machine. Completion, preset, prefix and agent scope live in
`$XDG_STATE_HOME/corgi/viewer.json`, defaulting to
`~/.local/state/corgi/viewer.json`. They are shared across launches and sockets;
setting `CORGI_SOCKET` no longer resets onboarding. A completed setup from the
current socket's older `.viewer.json` file is migrated if shared setup is missing.
The daemon does not read the viewer's shortcut preferences.

`corgi onboard` is the real wizard: imports operate on real source sessions.
Use **Skip import** to finish without importing.

The wizard is an ANSI terminal interface with a frame up to 112 columns × 32
rows. Every step keeps the same frame at a given terminal size. It requires at
least 76 × 26; imports and full keymaps scroll within the frame. There are no
review-handoff or shortcut-practice steps.

## Keys

Corgi is selected initially. Ctrl+B and Ctrl+A prefixes are supported; press the
chosen prefix twice to send that byte to the child. New-tab actions open the
Corgi agent/terminal picker. Ctrl+T is intercepted only by the Corgi preset.

| Action | Corgi | tmux | Herdr | cmux |
| --- | --- | --- | --- | --- |
| New tab / agent picker | P c | P c | P c | Cmd+T |
| Split right / down | P v / - | P % / " | P v / - | Cmd+D / Cmd+Shift+D |
| Focus pane | P hjkl | P arrows | P hjkl | Cmd+Option+arrows |
| Next / previous tab | P n / p | P n / p | P n / p | Cmd+Shift+] / [ |
| Copy mode | P s | P [ | P [ | Cmd+Shift+M |
| Setup | P C / i | P C | P s | Cmd+, |
| Detach | P q | P d | P q | P q |

`P` means the selected prefix. tmux tab numbering starts at zero; other presets
start at one. The full-keymap screen includes workspace, resize, agent and
navigation additions. These are Corgi action mappings, not command interpreters
for the source programs. Copy mode uses Corgi's existing selection and clipboard.

cmux shortcuts require host forwarding. The connection screen can install a
managed Ghostty config block on a local macOS Ghostty viewer. It discloses that
the bindings apply throughout Ghostty and replace host actions; a Ghostty config
reload is still required. Other terminals can use the portable Herdr preset.
Command-key forwarding is not claimed to have been observed or verified.

## Imports

Discovery runs on a worker in the viewer and never mutates a source. Source tabs
are independent of the selected shortcut preset. The display uses actual names
and hierarchy. Browser links, resume suggestions and new shells have distinct
annotations. Only live handoff displays PIDs.

- **tmux:** discover the inherited socket and sockets under `$TMUX_TMPDIR` or
  `/tmp/tmux-<uid>`. Copy selected sessions, named windows, pane folders and split
  geometry into new shells. No source commands are replayed and no tmux pane is
  closed. Non-guillotine/unsupported layouts fail and roll back the new shells.
- **Herdr copy:** use session snapshots, process metadata and layout exports;
  preserve split trees and known Codex/Claude resume references. Resume commands
  are shown as suggestions rather than executed. Select workspaces from one
  source session per transaction.
- **Herdr handoff:** enabled by default when the source advertises it. The entire
  source session moves, including all of its workspaces. Herdr's cooperative
  `server.live_handoff` protocol transfers PTY descriptors through a private
  bridge. Preparation and capacity checks precede commitment. Corgi reads the
  descriptors only after ownership is confirmed. An ambiguous post-ready outcome
  waits for confirmation while retaining the descriptors. Launch Corgi outside
  the Herdr session being moved; source-pane and foreground-process-group checks
  prevent moving the console that is displaying the wizard.
- **cmux:** use `cmux tree --all --json` to discover windows/workspaces, named panes
  and surfaces. Surfaces become Corgi tabs; browser URLs appear in the resulting
  terminal scrollback. Folders are copied when the source reports them; otherwise
  the workspace folder, then home, is used. Running processes remain in cmux.

The daemon reports real phases/counts through `onboarding.status`. Copy creates
one workspace per event-loop iteration and discards all newly created shells on
failure. Layout edits are blocked while a copy is active or Herdr has reserved
its destination. Reload/shutdown cannot interrupt an active import. An operation
ID makes repeated start requests idempotent while that operation is retained.
Completion is saved only when the user leaves the successful completion screen
(or explicitly skips importing). A failed import does not complete onboarding.

### Herdr boundaries

The transfer preserves running processes and terminal descriptors. Screen replay
and redraw are best effort. Source-specific environment variables, plugins and
hook endpoints are not rewritten inside existing processes; Corgi observes and
binds recognized agent sessions using its own mechanisms.

### Stock tmux on macOS: investigation only

A candidate is debugger-assisted `fileport_makeport`/`fileport_makefd` duplication
of the existing PTY, followed by ordinary tmux pane removal after a receiver is
ready. It changes no source or installed binary. A duplicate alone does not allow
two simultaneous readers, and descriptor flags must remain untouched while tmux
owns the pane. On cancellation before removal, closing the duplicate leaves tmux
intact. Restoring the same pane after removal is not a supported rollback.

This is **not implemented**. Debugger authorization, buffered input/output,
process/job-control fidelity, custom hooks, and partial-commit recovery need
disposable experiments. sudo is not a guarantee of task-port access. No real
session should be used to establish those properties.
