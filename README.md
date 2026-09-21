# Corgi

A multiplexer terminal agent manager, heavily inspired by [herdr](https://github.com/herdrdev/herdr), powered by [Ghostty](https://github.com/ghostty-org/ghostty).


## Development

Requires **Zig 0.15.2** on your PATH (or set `ZIG=/path/to/zig`). Tested on macOS Apple Silicon.

From this directory:

```sh
./go.sh
```

This builds Corgi and starts or attaches to its background runtime.

Multiple terminals can attach to the same runtime. They share workspaces, tabs, and split arrangement. Each viewer has its own selected workspace, tab, pane, menus, zoom, and scroll position. A pane fits the smallest viewer currently displaying it; other panes are unaffected. Detaching one viewer leaves the others connected.

The caret is steady by default while attached, preserving the host terminal's cursor shape. Corgi saves the host's blink mode and restores it on detach. Set `CORGI_CURSOR_BLINK=1` when launching a viewer to leave the host's blink behavior unchanged. This uses the terminal's DEC cursor-blink mode, supported by Ghostty; an explicit Ghostty `cursor-style-blink` setting takes precedence.

- **Ctrl-B** opens the clickable command menu and shows shortcuts.
- Click **+** to create a tab; right-click a tab to rename or close it. Unnamed tabs show their current position; clear a name to return to automatic numbering.
- Right-click a pane for rename, clear name, swap with the focused pane, split, zoom, and close. Opening the menu preserves focus. Hold Shift when a mouse-aware application owns right-click. Pane names appear in the focused-pane status line and override agent names in the sidebar.
- Drag workspace rows to reorder them; a horizontal line marks the destination. Release outside the workspace list or press Escape to cancel.
- Drag the sidebar's right edge to resize it. Width belongs to each viewer and resets on reattach.
- Drag a tab to reorder it; the vertical marker shows where it will land. Release outside the tab bar or press Escape to cancel.
- **Ctrl-B**, then **v** or **-** splits right or down.
- **Ctrl-B**, then **q** detaches while keeping your shells running. Run `./go.sh` to return.
- With one workspace, closing the last tab returns to your outer terminal. With multiple workspaces, an empty workspace stays open so you can switch or create a tab. Closed-pane snapshots remain available after reattaching.
- The left sidebar is split equally: **workspaces** above, **agents in the selected workspace** below. Click the workspace header **+** to create one; leave its name empty for automatic naming, or enter a custom name. Click a workspace to switch, or right-click to rename it. **Ctrl-B w** creates a workspace with just a name, inheriting the current workspace’s folder; **Ctrl-B W** edits it; **Ctrl-B { / }** switches. The workspace name and folder follow the working directory of tab 1 (the first tab in the current order). A custom workspace name overrides the automatic folder name; clear it to restore automatic naming. New tabs and splits use that folder. Existing panes keep their working directories.
- The **agent sidebar** shows a colored status circle and working directory, with an activity icon and agent name underneath. Click an agent to jump to its pane; **Ctrl-B**, then **b** toggles the sidebar.

Workspaces retain their tabs, focused panes, and running processes while switching or detaching. Workspace name overrides and folders are saved automatically across runtime restarts. Selection belongs to each viewer and is not saved across viewer restarts. Live reload preserves tabs and running processes. After a crash or reboot, Corgi restores the saved arrangement and terminal output into new shells, in their saved directories, with agent resume commands when known. No Git worktrees are involved.

```sh
corgi workspace new Backend ~/dev/backend
corgi workspace list
corgi workspace switch 1
corgi workspace edit 1 Personal ~/dev/personal
corgi workspace close 2  # only when empty
```

Agents can discover the command interface with `corgi --help` and load the bundled
Markdown guide with `corgi --skill`. Explicit targets avoid changing another
viewer's focus; layout moves preserve running processes and pane IDs.

```sh
corgi list
corgi tab rename current Backend
corgi tab move 12 --before 8
corgi pane split current --right
corgi pane move 31 --new-tab --name Logs
corgi tab merge 12 --right-of 42
```

IDs above are examples: use IDs from `corgi list`. `current` resolves the calling
pane's live location. Commands return JSON; `--text` makes discovery readable or
prints terminal text directly. Run `corgi tab` or `corgi pane` for usage.

Run agents normally inside a pane:

```sh
codex
claude
```

Corgi detects agents automatically, including Bun and Node launches, and sets up hooks in existing Codex/Claude settings directories. Existing settings are preserved, with a backup before editing. Codex may ask you to trust the hooks in `/hooks`.

Run `./go.sh` to build and launch: it starts the runtime if needed and live-reloads it only when the binary changed. From inside a Corgi pane, it asks the viewer focused on that pane to detach and re-exec the freshly built client. Running panes survive both operations. Existing viewers from before this feature need one manual **Ctrl-B q** and `./go.sh`; if multiple viewers focus the invoking pane, detach and reattach the intended viewer manually. `./go.sh --reload` forces a daemon-only live reload. Failed hot reloads leave the runtime and panes running; they never fall back to a destructive restart. `./go.sh --restart` is a destructive runtime restart; save work and run it from outside Corgi. It requires typing `yes` at an interactive confirmation before terminating an existing runtime, as does `./go.sh shutdown`. Empty input, any other answer, or noninteractive input cancels. Other arguments are passed through to the CLI.

Recovery snapshots are saved every two seconds when state changes, and on clean shutdown. `corgi checkpoint` saves immediately and prints the private file path. Restored agent commands are displayed for you to run; they are never executed automatically. Shell command history remains managed by the shell.

Tests: `./scripts/zig build test`, then `./scripts/zig build -Doptimize=ReleaseSafe -Dviewer-test-driver=true`, `python3 tests/smoke.py`, `python3 tests/viewers.py`, and `python3 tests/reloads.py`. The last suite drives multiple real viewer controllers over an isolated test transport.

The [development reload milestones](docs/development-reloads.md) describe the
versioned runtime interface, viewer-owned UI, live handoff, and recovery after reboot.

See the [reference](docs/reference.md) for all controls and agent APIs.
