# Corgi

A multiplexer terminal agent manager, heavily inspired by [herdr](https://github.com/herdrdev/herdr), powered by [Ghostty](https://github.com/ghostty-org/ghostty).

Release installations download updates in the background and apply them on the
next launch when the running session can safely hand off. `corgi update status`
shows update state; `corgi update` checks and applies explicitly. See
[releases and automatic updates](docs/releases.md) for installation, controls,
and the single-command macOS arm64 + Linux amd64 R2/S3 publishing workflow.


## Install

macOS Apple Silicon (13+) or Linux amd64:

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

The installer adds `~/.local/bin` to PATH for your shell, then Enter starts
Corgi. After that, run `corgi`.
Updates download in the background and apply on the next launch.

To uninstall, quit Corgi and run the installer with `uninstall`. It keeps
saved sessions and settings in `~/.local/state/corgi`.

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## Development

Corgi runs on **Bun**. Its native layer (terminal emulation, PTYs, keyboard
encoding, crash reports) is Zig and needs **Zig 0.16.0** on your PATH (or set
`ZIG=/path/to/zig`). `bun build.ts` builds both into `dist/corgi`.

From this directory:

```sh
./go.ts
```

This builds Corgi and starts or attaches to its background runtime.

To try onboarding in an isolated Corgi environment, run from a terminal outside Corgi:

```sh
./go.ts --temp          # fresh setup every time
./go.ts --env demo      # reusable environment; setup once
./go.ts --env demo onboard  # reopen its onboarding
```

Each environment has its own runtime, preferences and saved state. Named environments
survive restarts and reboots. Temporary environments print a reconnect command and
keep running after detach; shutdown still requires confirmation.

`./publish.sh` builds, signs and publishes a release; see
[releases](docs/releases.md).

Multiple terminals can attach to the same runtime. They share workspaces, tabs, and split arrangement. Each viewer has its own selected workspace, tab, pane, menus, zoom, and scroll position. A pane takes the size of the most recently used viewer displaying it (typing, clicking, or resizing counts as use); other viewers clip or pad it. Detaching one viewer leaves the others connected.

The caret is steady by default while attached, preserving the host terminal's cursor shape. Corgi saves the host's blink mode and restores it on detach. Set `CORGI_CURSOR_BLINK=1` when launching a viewer to leave the host's blink behavior unchanged. This uses the terminal's DEC cursor-blink mode, supported by Ghostty; an explicit Ghostty `cursor-style-blink` setting takes precedence.

- **Ctrl-B** opens the clickable command menu and shows shortcuts; `corgi keys` lists every preset's keys.
- Click **+** to create a tab; right-click a tab to rename or close it. Unnamed tabs show their current position; clear a name to return to automatic numbering.
- Right-click a pane for rename, clear name, swap with the focused pane, split, zoom, and close. Opening the menu preserves focus. Hold Shift when a mouse-aware application owns right-click. Pane names appear in the focused-pane status line and override agent names in the sidebar.
- Left-drag selects text and copies it on release. When the app in a pane enables mouse input, such as Claude Code's fullscreen mode, its clicks, drags and hover go to the app instead, and what the app copies reaches your clipboard; hold Shift to select with Corgi.
- Drag workspace rows to reorder them; a horizontal line marks the destination. Release outside the workspace list or press Escape to cancel.
- Drag the sidebar's right edge to resize it. Width belongs to each viewer and resets on reattach.
- Drag a tab to reorder it; the vertical marker shows where it will land. Release outside the tab bar or press Escape to cancel.
- **Ctrl-B**, then **v** or **-** splits right or down. Split layouts reserve a one-cell outer frame and highlight the focused pane’s whole outline, including outer edges. Single-pane and zoomed views use the full terminal area.
- **Ctrl-B**, then **q** detaches while keeping your shells running. Run `./go.ts` to return.
- With one workspace, closing the last tab returns to your outer terminal. With multiple workspaces, an empty workspace stays open so you can switch or create a tab. Closing a running agent keeps it: **Ctrl-Shift-T** or **Cmd-Shift-T** (or **Ctrl-B**, then **u**) resumes it in a new tab over its faded old screen, even after reattaching.
- The left sidebar is split equally: **workspaces** above, **agents in the selected workspace** below. Click the workspace header **+** to create one; leave its name empty for automatic naming, or enter a custom name. Click a workspace to switch, or right-click to rename it. **Ctrl-B w** creates a workspace with just a name, inheriting the current workspace’s folder; **Ctrl-B W** edits it; **Ctrl-B { / }** switches. The workspace name and folder follow the working directory of tab 1 (the first tab in the current order). A custom workspace name overrides the automatic folder name; clear it to restore automatic naming. New tabs and splits use that folder. Existing panes keep their working directories.
- The **agent sidebar** shows a colored status circle and agent name, with activity underneath. For Codex panes, the activity line ends with `↳2` when two direct subagents are running; `!1` adds one child needing input. An explicit wait shows **Waiting on agents**. The badge disappears when no children are running or need input, keeping every entry two lines tall. Click an agent to jump to its pane; **Ctrl-B**, then **b** toggles the sidebar. Click the corgi badge (or **Ctrl-B i**) to choose which harness writes activity summaries and link names; **Auto** follows the agents you run. See [workspace activity](docs/workspace-activity.md#agent-activity-summaries).
- **Ghostty integration (macOS):** click the corgi badge or press **Ctrl-B i**, then select **Enable Ghostty integration**. This binds **Cmd+1–9** to tabs, **Cmd+T** to the new-agent picker, **Cmd+W** to close the current tab and all its panes, and **Ctrl+Tab / Ctrl+Shift+Tab** to next/previous tab. The bindings type your prefix and your preset's keys, and are rewritten when you change either; under the cmux preset they send cmux's Command shortcuts instead. They apply throughout Ghostty, including outside Corgi. Press **Cmd+Shift+,** in Ghostty after enabling, disabling or changing them. Corgi preserves existing settings and removes only its managed block when disabled; any pre-existing bindings remain. This is available from local macOS viewers, not SSH sessions. Custom Ghostty launch flags or included configuration files can override these bindings.

- **Agent navigation stays within the current workspace’s sidebar list**, including scrolled-off agents and native sessions. **Ctrl-B g** focuses the existing agent sidebar and adds an inline search field: type a name, provider, status, activity, or path; use **Up/Down** (or **Tab/Shift-Tab**) and **Enter**, or click a row. **Escape** clears the filter and returns to the current pane. **Ctrl-B ←** from the leftmost pane moves focus into the sidebar: **Up/Down** move through agents (**Ctrl-B Up** reaches workspaces), **Enter** opens one, **Escape** returns. **Ctrl-B [ / ]** cycles backward/forward in sidebar order and wraps. **Ctrl-B Tab** returns to the previously focused agent, with separate history per workspace. **Ctrl-B s** enters scroll/copy mode (previously `Ctrl-B [`).

Each workspace uses two content rows: its name, `Open Link ↗` action, and Git status above; agent status, unread count, and nonzero background process count below. The link action is for confirmed HTTP/HTTPS destinations (root GET returns 2xx/3xx). One destination opens directly; multiple destinations show a count and open a URL chooser. Click a URL or use arrow keys and Enter; Escape or clicking outside dismisses the chooser. Duplicate URLs are collapsed. On local viewers, ordinary clicks open your default browser; dragging cancels the click. On SSH viewers, Corgi can't open your browser, so use your terminal's link gesture on the icon or a chooser URL. In Ghostty that is Cmd+Shift-click (Ctrl+Shift-click on Linux): Corgi captures the mouse, and Shift tells Ghostty to skip that and open the link itself. Non-browser ports remain available in the full inventory, including process names, PIDs, HTTP status, bind addresses and matching interfaces, in the `ports` field of `corgi rpc '{"op":"session.snapshot","protocol":1}'`. Named hyperlinks printed by pane programs retain their targets through Corgi. Plain `http://` and `https://` URLs also become terminal hyperlinks, including URLs wrapped within a pane. Corgi underlines links on hover. Clicking or Ctrl-clicking opens a URL locally when the button is pressed and released on the same cell; a drag that starts or ends on a link selects text instead. Cmd+Shift-click (Ctrl+Shift-click on Linux) hands a link to Ghostty instead, which opens it on the machine running the terminal. In mouse-aware programs other than agents, plain clicks reach the program and Ctrl-click opens links.

Links are selected independently by each viewer. Local viewers use `localhost` for wildcard and standard loopback binds, or the actual address for a specific network bind. SSH viewers prefer matching Tailscale addresses, then other VPN addresses, then ordinary network addresses. Loopback-only services are omitted from the SSH link control; Corgi does not create SSH tunnels. Interface classification is best-effort (interface names and Tailscale address ranges), and a matching bind does not guarantee remote reachability. IPv6 wildcard candidates stay IPv6 rather than assuming dual-stack support.

Discovery uses `ps` and `lsof` on the server, plus `curl` for bounded HTTP/HTTPS GET probes (requesting at most the first 4 KiB via Range). Install `lsof` and `curl` on Linux if absent. Scans run off the UI thread, normally every three seconds; probes are cached and limited to four per scan, with unknown/error endpoints retried after 15 seconds and successful ones after a minute. HTTPS detection accepts self-signed certificates; opening a link still uses the browser's normal certificate checks. The `bg` count covers workspace work processes, including servers running in the foreground of their own pane. Shells and agent controllers are excluded from both the count and port inventory; agent-launched work processes and their ports are included. Counts are OS processes, so a launcher and its worker may count separately. Fully detached/reparented daemons may lose workspace attribution.

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

Run `./go.ts` to build and launch: it starts the runtime if needed and live-reloads it only when the binary changed. From inside a Corgi pane, it asks the viewer focused on that pane to detach and re-exec the freshly built client. Running panes survive both operations. Existing viewers from before this feature need one manual **Ctrl-B q** and `./go.ts`; if multiple viewers focus the invoking pane, detach and reattach the intended viewer manually. `./go.ts --reload` forces a daemon-only live reload. Failed hot reloads leave the runtime and panes running; they never fall back to a destructive restart. `./go.ts --restart` is a destructive runtime restart; save work and run it from outside Corgi. It requires typing `yes` at an interactive confirmation before terminating an existing runtime, as does `./go.ts shutdown`. Empty input, any other answer, or noninteractive input cancels. Other arguments are passed through to the CLI.

Recovery snapshots are saved every two seconds when state changes, and on clean shutdown. `corgi checkpoint` saves immediately and prints the private file path. Restored agent commands are displayed for you to run; they are never executed automatically. Shell command history remains managed by the shell.

Tests: `bun test src` and `bun typecheck.ts`, then `bun build.ts --test` and `bun integration.ts`. Suites run in separate Bun processes; see [tests/README.md](tests/README.md) for focused runs and optional external-runtime tests.

The [development reload milestones](docs/development-reloads.md) describe the
versioned runtime interface, viewer-owned UI, live handoff, and recovery after reboot.

See the [reference](docs/reference.md) for all controls and agent APIs.
