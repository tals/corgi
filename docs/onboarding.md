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

For an isolated walkthrough, run `./go.sh --temp` from a terminal outside Corgi.
Every invocation starts with fresh Corgi state and onboarding. Use `./go.sh --env demo`
to keep a separate named environment: it shows onboarding until you finish setup,
then remembers your choice. `./go.sh --env demo onboard` reopens it explicitly.
Detaching leaves the runtime running; temporary launches print a reconnect command.
Imports still operate on real source sessions.

The wizard is an ANSI terminal interface with a frame up to 112 columns × 36
rows. Every step keeps the same frame at a given terminal size. It requires at
least 76 × 26 for the wizard; the full keymap supports terminals down to 32 × 12.
Imports and full keymaps scroll within the frame. There are no
review-handoff or shortcut-practice steps.

The preset screen uses highlighted modifier keycaps, an agent-picker shortcut,
and pane diagrams for splitting and focus. The layout compacts at smaller sizes;
P changes the portable prefix and ? opens the full keymap. The keymap has two
panes that scroll together: tabs/workspaces/agents on the left and
panes/terminal/Corgi commands on the right. Panes has Focus and Swap key diagrams,
Split diagrams, Arrange, and Close & recover groups. Below 60 columns, the two
panes stack into one scrolling list. ↑/↓, j/k, PgUp/PgDn, and the mouse wheel
scroll the reference; Esc returns. The prefix and footer remain visible.

The same screen opens inside Corgi with **prefix ?**. The prefix alone waits
silently for the next key. In the screen, press an action key or click its
label/key to run it; Esc or Enter closes the screen.
The prefix is already active, so j/k focus panes and q detaches in the Corgi
preset. PgUp/PgDn and the wheel scroll; arrows also scroll except in tmux, where
they focus panes. It uses the current preset and prefix in both places.
The cmux shortcut preset and import source appear only in macOS builds. Preferences
copied from a Mac use the Corgi preset on other platforms.
For cmux, P marks portable prefix alternatives alongside Command shortcuts.

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

Herdr is the initial import source when its executable is on `PATH` or a known
Herdr socket exists. A source chosen manually stays selected when navigating back.
Onboarding defers the starter shell; after a successful copy or handoff, an
untouched empty starter workspace is removed. Existing workspaces are retained.

- **tmux:** discover the inherited socket and sockets under `$TMUX_TMPDIR` or
  `/tmp/tmux-<uid>`. Copy selected sessions, named windows, pane folders and split
  geometry into new shells. Zoomed windows import all panes in their saved,
  unzoomed arrangement; the source window stays zoomed. No source commands are
  replayed and no tmux pane is closed. Unreadable layouts fail discovery; geometry
  that cannot be reconstructed fails the copy and rolls back the new shells.
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
- **cmux (macOS builds only):** discover windows, workspaces and surfaces with `cmux tree --all --json`.
  Each workspace becomes a Corgi workspace. Its first tab reconstructs the visible
  splits using the selected surface in each cmux pane. Additional tabs take one
  remaining surface per source pane, in source order; empty branches collapse.
  Every readable surface appears once. There are no model calls during import.
  Split trees preserve direction, nesting and ratios within Corgi's limits. When
  unavailable, `list-panes` rectangles reconstruct the geometry; otherwise a
  balanced layout approximates it. Browser URLs appear in terminal scrollback.
  Missing or unusable folders fall back to the workspace folder, then home.
  Running processes remain in cmux; Corgi starts new shells.

  Discovery is best effort: unknown entries do not discard readable surfaces or
  other workspaces. Older CLI flags are retried, and unreadable tree output falls
  back to window/workspace listings. If only workspace metadata can be recovered
  (or a workspace exceeds import limits), its name and usable folder are copied
  with one new shell. Per-workspace notes show approximated layouts, missing
  details and workspace-only recovery. A confused `ᐱoᴥ°ᐱ` blinks briefly every
  five seconds with “I'm confused by this cmux version. I'll bring over what I
  can.” Completely unreadable discovery offers refresh/skip without claiming
  that the source has no workspaces. No source commands are replayed. The CLI is
  found on `PATH` or in the standard macOS cmux application locations.

The cmux integration fixtures run through the real wizard and daemon without a
live cmux app or agent accounts:

```sh
./scripts/zig build -Doptimize=ReleaseSafe -Dviewer-test-driver=true
python3 tests/cmux_import.py
```

Set `CORGI_TEST_BIN` to test an isolated build. Conversion and split validation
tests are also included in `./scripts/zig build test`.

The daemon reports real phases/counts through `onboarding.status`. Copy creates
one workspace per event-loop iteration and discards all newly created shells on
failure. Layout edits are blocked while a copy is active or Herdr has reserved
its destination. Reload/shutdown cannot interrupt an active import. An operation
ID makes repeated start requests idempotent while that operation is retained.
Completion is saved only when the user leaves the successful completion screen
(or explicitly skips importing). A failed import does not complete onboarding.

### Running the handoff integration suite

The slower, real-process migration tests have their own Zig build step:

```sh
./scripts/zig build test-handoff -Doptimize=ReleaseSafe
```

This builds Corgi and runs `tests/herdr_handoff.py` using Python's standard-library
`unittest` harness. It requires a Herdr binary on `PATH` with `live_handoff`
support. Select another binary with `-Dherdr-bin=/absolute/path/to/herdr` or
`HERDR_TEST_BIN`. Missing or incompatible Herdr fails the requested suite.

`zig build test` and ordinary builds do **not** run handoff tests. The suite needs
no viewer test driver and invokes the daemon's onboarding RPC directly. Forward
unittest selectors after `--`, for example:

```sh
./scripts/zig build test-handoff -Doptimize=ReleaseSafe -- -k rejected
```

Each case creates disposable Herdr and Corgi runtimes with isolated homes,
configuration, state and sockets. It runs local shells and a small foreground
worker, with Corgi inference and Herdr update checks disabled. Cleanup stops only
fixture processes; failures include their log tails. Existing sessions and agent
accounts are not used.

Coverage includes unchanged shell/foreground PIDs, an unexported shell variable,
continued work, terminal input/output, named workspaces/tabs, splits, existing
destination panes, duplicate-request handling, and rollback followed by retry.
This tests the handoff protocol and process ownership; wizard rendering is separate.

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
