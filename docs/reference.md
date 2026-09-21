# Corgi reference

A small terminal multiplexer for agents, written in Zig, using **Ghostty's native Zig VT module**. Corgi owns the PTYs and background runtime. Workspaces group tabs and panes with a default working folder. No tmux or Git worktrees.

## Run

Requires **Zig 0.15.2**, pinned to the Ghostty revision in `build.zig.zon`. The host's Zig 0.16 is not compatible with this dependency. `scripts/zig` selects a matching compiler from `ZIG`, PATH, or the local `.tools/` download.

```sh
./go.sh                        # ReleaseSafe build, then start or attach
./go.sh --reload               # rebuild and replace daemon; panes/viewers stay alive
./go.sh --restart              # stop processes, then recover in new shells
./scripts/zig build test
python3 tests/smoke.py          # real PTYs + socket tests; mock providers, no inference
```

After building, the executable is `zig-out/bin/corgi`. Its directory is added to each pane's PATH. Ordinary `go.sh` preserves the running runtime; UI-only changes load in a newly opened viewer. `./go.sh --reload` builds, transfers the live runtime to that executable, and returns to the current terminal. It works inside a Corgi pane. `corgi reload [ABSOLUTE_EXE]` uses an already built executable. A failed build or handoff leaves the old runtime serving; there is no destructive fallback. An older daemon without export support needs one final ordinary restart after saving work.

`./go.sh --restart` remains an explicit process restart: it terminates existing processes and starts new shells from saved recovery context. Run it outside Corgi. Put flags first; further arguments are passed through, e.g. `./go.sh --restart start`. It cannot preserve process memory or unsaved application work.

Live handoff transfers compact VT snapshots of retained screens, history, cursor, and input modes instead of accumulated terminal event journals. After the new daemon owns the PTYs, it briefly changes each PTY width and restores it 250 ms later, asking applications to repaint through ordinary resize notifications. Processes and PTYs stay alive; parser fragments and some saved terminal state may be lost, and applications that do not repaint can retain display artifacts. Older daemons' exact replay checkpoints remain importable.

Pane IDs and split arrangement survive live handoff. Connected viewers retain their local selection, menus, scroll positions, and input parser because their sockets and viewer processes remain alive. Native JSONL sessions retain their pipes, partial messages, outstanding approvals, and process IDs. Legacy raw socket `attach` clients must detach before handoff; normal `corgi` viewers can stay connected.

Recovery snapshots preserve workspace/tab/split arrangement, working directories, retained terminal output, and recorded agent session IDs. They are written atomically with mode 0600 in a private directory under `$XDG_STATE_HOME/corgi/recovery` (default `~/.local/state/corgi/recovery`), with a separate file per socket path. Changed state is saved every two seconds and before clean shutdown; `corgi checkpoint` saves immediately and prints the path. A crash can lose changes since the last completed save. Snapshots contain terminal contents and should be treated as private session data.

After a crash or reboot, starting Corgi loads that snapshot into fresh shells. Saved output includes retained primary history and alternate-screen contents as scrollback, without the old process's input modes. Each pane shows its previous directory and `codex resume 'SESSION_ID'` or `claude --resume 'SESSION_ID'` when a session was recorded. Without a known ID, a recognized provider gets its interactive resume picker command. These commands are displayed, never executed automatically. Native sessions become archived records with a recovery shell tab showing their saved journal and resume command. Missing directories fall back to HOME; the old path remains visible. Shells still manage their own command history files; Corgi cannot recover unsaved shell history or arbitrary application memory.

The handoff manifest is limited to 256 MiB. If retained snapshots and other runtime state exceed that limit, the terminal dependency changes, accepted writes cannot drain, a legacy viewer remains attached, or candidate restoration fails, reload is rejected and the current runtime continues. A successfully committed new daemon can still crash like any other process; disk recovery is the fallback then. Rebuilding does not update the exporter inside an already running daemon: an old daemon blocked by its checkpoint limit cannot acquire this fix merely by retrying reload.

Multiple viewers can attach at once. They share workspace/tab order, split ratios, names, and running processes. Each owns its selected workspace/tab/pane, zoom, menus, dialogs, scroll/copy state, and mute setting. Shared edits appear in every viewer; closing a selected pane chooses a surviving pane locally. Pane sizes use the minimum dimensions among the viewers actually displaying that pane. Hidden panes keep their last size; detaching a smaller viewer allows others to grow. `prefix q` detaches only that viewer. Closing the last pane in the only workspace detaches everyone. The earliest live viewer supplies terminal theme defaults.

Normal attachments compose their UI locally from session snapshots and terminal surfaces. The old socket `attach` operation remains available as a compatibility adapter, with its original shared-view semantics. New viewers check daemon capabilities and report when an older daemon needs an update; they never restart it automatically.

## Agent CLI

`corgi --skill` prints the [bundled agent guide](../src/corgi-skill.md); the main
help includes the instruction to load it only when it is not already in context.
`corgi tab`, `corgi pane`, and command `--help` show usage without connecting.

`corgi list` returns a versioned session snapshot in `result`, plus `viewers`.
Workspace entries contain ordered tabs and split trees; pane entries contain
stable IDs, live location, cwd, PID, and agent observations. `corgi current`
resolves `CORGI_PANE` through the runtime, so its tab/workspace remain accurate
after moves. `--text` pretty-prints JSON; `pane read --text` emits plain text.
The legacy `rpc {"op":"list"}` response remains available unchanged.

```sh
corgi tab new --name Tests --workspace 1 --cwd /absolute/project/path
corgi tab rename 12 Backend
corgi tab rename 12 --clear
corgi tab move 12 --before 8
corgi tab move 12 --workspace 2
corgi pane split current --right
corgi pane move 31 --below 42
corgi pane move 31 --new-tab --name Logs
corgi tab merge 12 --right-of 42
corgi pane swap 31 42
corgi pane resize 31 --width 60%
corgi pane read 31 --lines 100 --text
corgi pane send 31 --stdin --enter < /path/to/prompt.txt
corgi pane keys 31 ctrl+c
corgi focus 31 --viewer 1
```

Move/merge support `--left-of`, `--right-of`, `--above`, and `--below`; split
supports `--left`, `--right`, `--up`, and `--down`. Tab merge preserves the entire
source split tree. Empty source tabs disappear; processes, output, and pane IDs
survive, including across workspaces. Resize sets the target side's percentage
of the nearest matching-axis split (10%-90%), including other panes on that side.

Creation and layout mutations return affected `pane`, `tab`, and `workspace` IDs
in `result`. Layout mutations validate on copies before committing and do not
select a viewer. Explicit focus requires a viewer ID from `list`.
`pane close ID` and `tab close ID` terminate the targeted processes without a
prompt; successful responses list `result.closed_panes`.

The new commands never implicitly start or restart a server. They return JSON
errors on stderr, exit 2 for invalid usage and 1 for runtime failures. Existing
legacy controls remain available, but focus now requires `--viewer` in the CLI.
The server exposes these operations through protocol-1 `cli.control`.

Regression suite: `python3 tests/cli.py` uses isolated sockets and provider settings.

## Tabs and panes

`prefix` means press Ctrl-B, release, then the next key. **Ctrl-B immediately opens a compact command menu**: press a displayed shortcut or click its row. Escape, the menu's `x`, or a click outside dismisses it. Resize has its own clickable direction menu. In short terminals, use the menu's previous/next buttons, the wheel, or PageUp/PageDown to see more commands.

Click **+** after the visible tabs, choose **New tab** from a menu, or press `prefix c` to open the **new tab** dialog. The empty name field previews the new tab's position as a number. Save (Enter) creates an unnamed tab in the workspace default directory unless you type a custom name; Cancel (Escape or clicking outside) creates nothing. Unnamed tabs store no name: their displayed numbers are recomputed as tabs move or close. The + button remains visible when tabs overflow. The CLI/control API still creates tabs immediately, unnamed unless an explicit title is supplied.

Headers show either the custom name or the automatic number, centered in a minimum width of 10 columns. Narrow terminals clip the active tab as needed while keeping **+** accessible.

**Rename tab** uses the same bordered dialog. Type to replace the selection, or move the cursor with Left/Right, Home/End and edit with Backspace/Delete. Ctrl-C, Ctrl-U, or **Clear** empties the field; saving an empty field removes the custom name and restores automatic numbering. The number shown in an empty field is a preview, not saved text. A number you explicitly type is a custom name and stays fixed. Save, Clear, and Cancel are clickable. Cancel leaves the existing name unchanged.

Right-click a tab title for Herdr's tab menu: **New tab**, **Rename**, and **Close**. Actions target the clicked tab; opening or dismissing the menu does not switch tabs. Click a row, or use Up/Down (or j/k) and Enter. Escape or a click outside dismisses it. New tab uses the workspace default directory and prompts for a name; Close immediately ends all of that tab's panes.

| Action | Key |
| --- | --- |
| New tab | `prefix c` |
| Split right / down | `prefix v` / `prefix -` |
| Focus left / down / up / right | `prefix h/j/k/l` |
| Swap in a direction | `prefix H/J/K/L` |
| Zoom / unzoom | `prefix z` |
| Resize mode | `prefix r`, then `h/j/k/l`; any other key exits |
| Next / previous tab | `prefix n/p` |
| Jump to tab | `prefix 1–9` |
| Rename tab | `prefix T` |
| Close pane / tab | `prefix x` / `prefix X` |
| Reopen last closed pane | `prefix u` |
| Break pane into its own tab | `prefix !` |
| Scroll/copy mode | `prefix [` |
| Jump to attention | `prefix a` |
| Mute / unmute sounds | `prefix m` |
| Detach, keep processes alive | `prefix q` |
| Help | `prefix ?` |
| Send literal Ctrl-B | `prefix Ctrl-B` |

Click tabs and panes to focus. Drag split dividers to resize. Drag terminal text to select and copy through OSC 52. Mouse-aware terminal applications receive translated mouse input through Ghostty; hold Shift to select text instead. Right-click opens the command menu when the terminal application is not handling the mouse. Wheel scrolling enters scroll mode. In scroll mode: `j/k`, Ctrl-U/D, PageUp/Down, `g/G`, `/` literal search, `n/N` repeat, `y` or Enter copies the selection (or viewport), `q` exits. Output keeps running while you scroll.

`corgi action move-tab left|right` reorders tabs. `corgi action join N` moves the focused pane into tab N. New tabs and splits use the workspace default directory.

Exiting a shell immediately removes its pane; an empty tab disappears too. Corgi keeps the last **eight closed panes** in memory, including terminal output and scrollback, the tab name, and the last observed working directory. `prefix u` (or `corgi action undo-close`) restores the most recent one in its original workspace (or the current one if removed), into a new tab with a **fresh shell**, not the old process or agent session. With one workspace, closing the last tab automatically detaches and returns to the outer terminal. Run `./go.sh` to reattach with a new shell, then `prefix u` to restore a snapshot. Snapshots and native agent sessions remain in the background runtime until it shuts down.

This is an initial implementation of Herdr's core tab/pane operations. Copy mode is intentionally smaller: it does not yet reproduce all of Herdr's vi word motions, keyboard selection, smart-case search, or configurable bindings. Multiple viewers share arrangement and independently select what to view. Limits: 24 tabs per workspace, 64 panes, 16 native provider processes, 10,000 scrollback lines per terminal.

The additive [runtime protocol](development-reloads.md#protocol-1) exposes shared
session snapshots, pane surfaces, and operations with explicit targets for the
viewer-owned UI. The legacy socket attachment path remains supported.

## Agent integration

The left sidebar is split 50/50: workspaces above, agents from the selected workspace below, in tab order. Click + beside workspaces to enter just a name (the focused pane’s current directory is inherited), click a workspace to switch, and right-click for **Rename** and **Close**. Menu actions target the clicked workspace. Close ends its panes and native sessions and removes the workspace; the last workspace cannot be closed. `prefix w` creates, `prefix W` edits, and `prefix {` / `prefix }` switch workspaces. Each workspace retains its tabs; each viewer remembers its focused pane within them. Processes keep running while hidden. New tabs and splits inherit the focused pane’s current directory (a targeted split inherits its target pane’s directory), falling back to the workspace’s default folder when empty; explicit RPC `cwd` overrides it. Changing a default folder does not change existing shells. Workspace names, IDs, and default folders are saved automatically across restarts. Each viewer owns its selection; tabs and processes are not restored after a daemon restart. State lives at `$XDG_STATE_HOME/corgi/workspaces.json` (default `~/.local/state/corgi/workspaces.json`), or beside an explicit `CORGI_SOCKET` as `<socket>.workspaces.json`. `corgi workspace list`, `new NAME [DIR]`, `switch ID`, `edit ID NAME DIR`, and `close ID` provide CLI access; close requires an empty workspace with no native sessions. Each entry has two rows: a colored status circle followed by the working directory, then an activity icon beneath the circle and the agent name. The activity icon is blank when idle, 🧠 while thinking, and 🔧 during a known tool call or its approval prompt. Paths under your home use `~`; long paths are shortened from the left so the current directory remains visible. Hook-reported directories take precedence over the foreground process directory; native sessions show their launch directory. Tab names, tool names, and routine lifecycle messages are omitted.

The indicators match Herdr's dot style: yellow filled circle for working, red filled circle for blocked, teal filled circle for an unseen completion, green hollow circle for idle, and a muted dot for unknown. Corgi adds a muted purple circle for initialization, with no activity icon; ended native sessions use a muted hollow circle. Click either row to focus its pane and acknowledge attention. Ordinary shells are omitted. Use the header arrow or `prefix b` to collapse/expand it; it also hides automatically in narrow or short terminals. Scroll with the wheel or the footer arrows when the list fills the screen.

Terminal agents are discovered from each pane's foreground process group, including native binaries and CLI scripts launched with Bun, Node, or Python. Ordinary shells are omitted, and an agent disappears when its process returns to the shell. Native App Server/stream sessions appear separately and use their protocol events. Clicking a native entry shows the command to inspect its events; it does not answer or dismiss pending approvals. State changes update the sidebar even when the agent's tab is hidden.

Inside a pane:

```sh
claude
codex
claude --resume SESSION_ID
claude --remote-control
codex resume SESSION_ID
```

At runtime startup, Corgi merges its hooks into `~/.codex/hooks.json` and `~/.claude/settings.json` when those provider directories exist. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are respected. It preserves other settings and hook handlers, saves the original file beside it as `.corgi-backup`, and writes atomically. Repeated startup does not duplicate hooks or rewrite unchanged files. Malformed files and symlinks are left untouched, with a diagnostic in the status bar/server log. Restart Corgi after first installing a provider. Hook setup applies to newly launched agent sessions.

The installed commands use the pane's `CORGI_BIN`, `CORGI_SOCKET`, and `CORGI_PANE`; they do nothing outside Corgi. Provider flags, login, model selection, inference, resume, and native remoting remain available. Permission policies and project configuration are unchanged.

Codex requires trusting new hook definitions in its `/hooks` UI. Corgi does not bypass hook trust, approvals, or disabled-hook settings. Until hooks arrive, strong visible prompt signals supply debounced working/waiting/idle status. New processes remain in initialization until their first recognized prompt or hook: title spinners alone never mean working, and fallback turn detection waits for the first stable idle prompt. Hook events take precedence once received; output activity alone never means a turn finished.

`corgi hooks claude|codex` prints hook configuration for inspection or your own integration. `corgi agent claude|codex ...` launches the discovered provider without injecting duplicate hooks.

For a running shared Codex daemon, Corgi identifies the CLI's displayed session from its terminal title. Include `"thread-id"` in `[tui].terminal_title` in your Codex config (for example `["app-name", "thread-id", "activity", "project"]`). Restart the CLI after changing this setting. Corgi resolves the truncated UUID only when exactly one loaded thread matches it, and checks that the title came from the current foreground process.

A separate read-only observer polls the default daemon every 500 ms for selected threads' status and latest turn. It never resumes threads, subscribes to approvals, or changes CLI arguments, shell aliases or CODEX_HOME. Initial attachment establishes a baseline without announcing historical completions; new completed turns update unread receipts and chimes. Multiple turns completed between polls may coalesce into one receipt. Missing/ambiguous titles or an unavailable daemon cannot establish a new binding; stale observations yield to screen detection after five seconds; ordinary hooks and screen detection remain available. Explicit remote or custom CODEX_HOME clients require their own observation source.

The optional launcher and native App Server sessions find Codex automatically: working executables on PATH first, then common user/system installation locations, then macOS app bundles in `~/Applications` and `/Applications` (including Codex and ChatGPT). Candidates must successfully answer `--version`; broken package wrappers, missing binaries, and hung commands are skipped. Run `corgi which codex` to see the selected executable. Legacy pane-launcher symlinks still pass arguments through unchanged and are skipped during discovery to avoid recursion.

Optional explicit `CORGI_CODEX_BIN` / `CORGI_CLAUDE_BIN` overrides remain available for development, set before starting the runtime.

Hooks describe working, waiting, tools, and session identity. `Stop` is provisional: the pane stays working with “checking completion” until the observer confirms the end of that turn. A shared worker checks only pending-stop transcripts, reads bounded appended chunks, backs off when completion is delayed, and never treats silence as completion. Codex requires matching session metadata and turn IDs in `task_complete`/`turn_complete`; Claude uses a fresh, matching-session `system/turn_duration` record after the Stop hook. Assistant messages and stop-hook summaries alone are not confirmation. These transcript formats are provider internals: missing paths, unsupported records, or missing Codex turn IDs leave completion unverified. Native sessions use protocol completion events. Screen-only idle remains an estimate and does not create unread results or completion sounds.

Unread results are independent of working/idle status. Each confirmed end of turn has a monotonic receipt number; a new turn does not erase unread results. A separate sidebar dot remains visible even while the agent works again. Active viewers automatically acknowledge the receipt they displayed when visiting a tab or pane (visible splits count; zoom-hidden panes do not). Background viewers do not acknowledge; terminal focus reporting depends on the host terminal. Receipts are shared across viewers and survive live reload and recovery. Delayed receipts cannot clear newer completions. Reading native events acknowledges that native session. Interrupted/failed turns retain their outcome without playing a successful-completion sound.

The sidebar shows bounded tool/thinking activity, provider-supplied tool descriptions when present, and the most recent completed tool. Generated semantic summaries and background inference are not enabled.

Provider contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks).

## A ding with somewhere to go

- **Needs you:** Herdr's request sound, including in the focused pane; unseen requests retain a sticky `! needs you` marker.
- **Turn finished:** Herdr's completion sound; sticky `+ done` marker.
- `prefix a` visits waiting panes first, oldest first, then completed panes. Visiting acknowledges the marker without changing the agent's actual state.
- Completion sounds stay quiet for a pane focused in any watching viewer. Input requests still ding. Focus reporting depends on the outer terminal supporting it.
- Completion receipts are deduplicated by turn. Duplicate hooks don't ring twice. Bursts are coalesced, with at least 1.5 seconds between sounds and waiting taking precedence.
- Muting suppresses sounds while retaining the attention queue. `CORGI_BELL=terminal` selects BEL; `CORGI_BELL=off` disables client sounds.

The two MP3s are embedded in the binary. Playback runs in a background thread using `afplay` on macOS, or the first successful MP3-capable player on Linux (`paplay`, `pw-play`, `ffplay`, `mpg123`, `mpv`). Temporary audio files are removed after playback; failed playback falls back to BEL. Plain SSH attachments use BEL so the notification reaches the local terminal rather than the remote host's audio device; its audibility depends on your terminal's bell settings.

Sounds play on the attached machine. A detached runtime retains attention markers but does not send desktop notifications. Native protocol sessions also contribute to the attention count; `prefix a` identifies the session and command to inspect it.

## Native agent protocols

For integrations that should not type into a terminal, Corgi can own durable provider processes independently of panes:

```sh
corgi native start codex
# => {"ok":true,"session":1,"provider":"codex"}
corgi native send 1 '{"id":1,"method":"thread/start","params":{}}'
corgi native events 1
# Read the returned provider thread.id, then:
corgi native send 1 '{"id":2,"method":"turn/start","params":{"threadId":"THREAD_ID","input":[{"type":"text","text":"Explain this project"}]}}'
corgi native events 1 10    # events after Corgi sequence 10
corgi native list
corgi native stop 1
```

This path uses **Codex App Server**, not Exec Server. Corgi performs the initialize/initialized handshake and queues requests until it completes. The provider's JSON-RPC messages remain intact: thread start/resume/fork, turn start/steer/interrupt, models, approvals, and supported remote-control methods are available through the same transport. See the [App Server protocol](https://developers.openai.com/codex/app-server).

For Claude, `corgi native start claude` launches its bidirectional streaming CLI with the host permission channel. Send SDK-compatible control/user messages with `native send`, inspect stream events with `native events`. For example, initialize with:

```sh
corgi native send 2 '{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}'
corgi native send 2 '{"type":"user","message":{"role":"user","content":"Explain this project"}}'
```

Native sessions expose protocol messages, not a custom chat UI. Approval/user-input requests remain in `pending_requests` until you send an explicit matching provider response. **Nothing auto-approves.** The event journal retains the latest 128 messages within 4 MiB and exposes `first_seq`/`next_seq` so consumers can detect eviction. Each event's `line` is the original JSON message, encoded as a string. Pending requests are stored separately, so event rotation cannot silently discard an unanswered approval. These are process-local buffers, not disk archives. Provider protocol/version compatibility remains the provider's responsibility; Claude's control channel is less stable than its documented terminal interface.

## Control API

All operations use newline-delimited JSON on a private Unix socket. By default: `/tmp/corgi-UID/control.sock`. Set `CORGI_SOCKET` to select another runtime in its own private directory. Direct `serve` runs the server in the foreground; ordinary startup handles locking and stale socket recovery.

```sh
corgi new 'bun run dev'
corgi split right
corgi list
corgi send 3 'run the tests' --enter
corgi read 3
corgi focus 3
corgi action rename api
corgi action attention
corgi shutdown              # ends this runtime and all its processes
```

`send` writes literal terminal input; `--enter` explicitly submits it. It is not a semantic provider RPC. `rpc JSON` exposes the underlying operations used by the CLI: `new`, `split`, `list`, `focus`, `close`, `send`, `read`, `action`, `hook`, `native.start/list/send/events/stop`, `ping`, `shutdown`. Pane and native-session IDs are separate namespaces.

With normal viewers, CLI navigation and actions target the oldest live viewer by default. They are queued and applied on its next update, then acknowledged. A subsequent split honors a queued explicit focus. If a pending local action makes the target uncertain, creation returns `ViewerBusy` until that action is acknowledged. To choose another viewer explicitly:

```sh
corgi rpc '{"op":"viewer.list"}'
corgi rpc '{"op":"focus","viewer":2,"pane":3}'
corgi rpc '{"op":"action","viewer":2,"name":"next","value":""}'
```

`viewer.list` reports each viewer's ID and last reported workspace/pane. When legacy socket viewers are attached, unqualified CLI controls retain their legacy behavior; an explicit `viewer` always selects one normal viewer. `list` and `workspace.list` retain legacy selection fields; use `viewer.list` for actual local-viewer selection. Explicit pane operations such as `send`, `read`, and `close` always address the pane ID.

For remote terminals, run Corgi on the host through SSH (`ssh -t host corgi`); the runtime persists there when the connection drops. Provider remoting can also be enabled through the native CLI/App Server interfaces. Corgi itself does not expose an unauthenticated TCP listener.

## Layout

- `layout.zig`: pure split tree, tab and pane identity, geometry, navigation.
- `terminal.zig`: PTYs, Ghostty parser/render state, selections and search.
- `server.zig` / `controller.zig`: shared interaction controller and legacy daemon adapter.
- `viewer.zig` / `client.zig`: viewer event loop and outer-terminal setup/cleanup.
- `mirror.zig`: local session projection and terminal framebuffers; no PTYs.
- `viewer_protocol.zig` / `protocol.zig`: runtime operations, snapshots, sizing interests, and conflict-checked shared edits.
- `runtime.zig`: shared workspaces, PTYs, native sessions, and closed panes.
- `render.zig` / `client.zig`: terminal presentation, attach, clipboard, sound.
- `commands.zig`: command menu layout, shortcut labels, and mouse targets.
- `name_dialog.zig`: tab name editor and dialog rendering/mouse targets.
- `workspace.zig`: workspace ownership, names, default folders, and pane lookup.
- `sidebar.zig`: workspace and agent list presentation, scrolling, and mouse targets.
- `agents.zig` / `integration.zig`: hook lifecycle evidence and provider launch configuration.
- `discovery.zig`: automatic provider executable discovery and bounded version checks.
- `native.zig`: durable App Server / Claude JSONL transports and retained approvals.
- `os.zig`: Unix/macOS boundary.

macOS arm64 is the exercised platform. Cross-compilation to x86_64 Linux passed; Linux runtime behavior still needs validation. Windows, graphics-protocol rendering, and daemon restart recovery are not implemented.
