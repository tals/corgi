# Corgi reference

A small terminal multiplexer for agents, written in Zig, using **Ghostty's native Zig VT module**. Corgi owns the PTYs and background runtime. Workspaces group tabs and panes with a default working folder. No tmux or Git worktrees.

## Run

Requires **Zig 0.16.0**, pinned to the Ghostty revision in `build.zig.zon`. `scripts/zig` selects a matching compiler from `ZIG`, PATH, or the local `.tools/` download.

```sh
./go.ts                        # build, then start or attach
./go.ts --temp                 # fresh isolated runtime, setup and state
./go.ts --env demo             # reuse an isolated named environment
./go.ts --env demo onboard     # reopen its onboarding
./go.ts --reload               # rebuild and replace daemon; panes/viewers stay alive
./go.ts --restart              # stop processes, then recover in new shells
./scripts/zig build test
bun run tests/run.ts smoke smoke_input smoke_terminal # real PTYs + socket tests; mock providers, no inference
```

After building, the executable is `dist/corgi`. Its directory is added to each pane's PATH. Ordinary `go.ts` preserves the running runtime; UI-only changes load in a newly opened viewer. `./go.ts --reload` builds, transfers the live runtime to that executable, and returns to the current terminal. It works inside a Corgi pane. `corgi reload [ABSOLUTE_EXE]` uses an already built executable. A failed build or handoff leaves the old runtime serving; there is no destructive fallback.

`./go.ts --restart` remains an explicit process restart: it terminates existing processes and starts new shells from saved recovery context. Run it outside Corgi. Put flags first; further arguments are passed through, e.g. `./go.ts --restart start`. It cannot preserve process memory or unsaved application work.

`--temp` and `--env NAME` select isolated runtimes before any reload or restart.
They also isolate preferences, onboarding completion, workspaces, inference settings
and recovery snapshots. Named data lives under
`${XDG_STATE_HOME:-$HOME/.local/state}/corgi/environments/NAME`; sockets use a short,
private directory under `/tmp`. Names contain up to 32 letters, digits, `_` or `-`
and start with a letter or digit. Named setup survives reboot; processes do not.
`./go.ts --env demo --reload` reloads only demo, and `./go.ts --env demo shutdown`
asks before stopping it. Switching environments requires a terminal outside Corgi;
inside a named environment, ordinary `./go.ts` keeps using that environment.

Temporary data lives in a fresh private `/tmp/corgi-temp-<uid>.*` directory.
Detach leaves its runtime alive and retains the directory. Use the printed reconnect
command to return, or append `shutdown` to it to stop the runtime with confirmation.
After shutdown, the printed directory can be removed. Source projects, agent accounts
and external import sources remain shared. These flags isolate Corgi state, not the
programs running inside it.

Live handoff transfers compact VT snapshots of retained screens, history, cursor, and input modes instead of accumulated terminal event journals. After the new daemon owns the PTYs, it briefly changes each PTY width and restores it 250 ms later, asking applications to repaint through ordinary resize notifications. Processes and PTYs stay alive; parser fragments and some saved terminal state may be lost, and applications that do not repaint can retain display artifacts.

Pane IDs and split arrangement survive live handoff. Connected viewers retain their local selection, menus, scroll positions, and input parser because their sockets and viewer processes remain alive. Native JSONL sessions retain their pipes, partial messages, outstanding approvals, and process IDs. Normal `corgi` viewers can stay connected. Upgrading from a daemon without `session.command` performs a one-time viewer relaunch while keeping pane processes alive.

Recovery snapshots preserve workspace/tab/split arrangement, working directories, retained terminal output, and recorded agent session IDs. They are written atomically with mode 0600 in a private directory under `$XDG_STATE_HOME/corgi/recovery` (default `~/.local/state/corgi/recovery`), with a separate file per socket path. Changed state is saved every two seconds and before clean shutdown; `corgi checkpoint` saves immediately and prints the path. A crash can lose changes since the last completed save. Snapshots contain terminal contents and should be treated as private session data.

After a crash or reboot, starting Corgi loads that snapshot into fresh shells. Saved output includes retained primary history and alternate-screen contents as scrollback, without the old process's input modes. Each pane shows its previous directory and `codex resume 'SESSION_ID'` or `claude --resume 'SESSION_ID'` when a session was recorded. Without a known ID, a recognized provider gets its interactive resume picker command. These commands are displayed, never executed automatically. Native sessions become archived records with a recovery shell tab showing their saved journal and resume command. Missing directories fall back to HOME; the old path remains visible. Shells still manage their own command history files; Corgi cannot recover unsaved shell history or arbitrary application memory.

The handoff manifest is limited to 256 MiB. If retained snapshots and other runtime state exceed that limit, the terminal dependency changes, accepted writes cannot drain, or candidate restoration fails, reload is rejected and the current runtime continues. A successfully committed new daemon can still crash like any other process; disk recovery is the fallback then. Rebuilding does not update the exporter inside an already running daemon: an old daemon blocked by its checkpoint limit cannot acquire this fix merely by retrying reload.

Multiple viewers can attach at once. They share workspace/tab order, split ratios, names, and running processes. Each owns its selected workspace/tab/pane, zoom, menus, dialogs, scroll/copy state, and mute setting. Shared edits appear in every viewer; closing a selected pane chooses a surviving pane locally. Each pane takes the dimensions of the most recently used viewer displaying it: input or a window resize makes a viewer the most recent, and so does attaching. Other viewers clip or pad that pane. Hidden panes keep their last size. `prefix q` detaches only that viewer. Closing the last pane in the only workspace detaches everyone. The earliest live viewer supplies terminal theme defaults.

Attachments compose their UI locally from session snapshots and terminal surfaces. The viewer and daemon use the same current protocol.

## Agent CLI

`corgi --skill` prints the [bundled agent guide](../src/corgi-skill.md); the main
help includes the instruction to load it only when it is not already in context.
`corgi tab`, `corgi pane`, and command `--help` show usage without connecting.

`corgi list` returns a versioned session snapshot in `result`, plus `viewers`.
Workspace entries contain ordered tabs and split trees; pane entries contain
stable IDs, live location, cwd, PID, and agent observations. `corgi current`
resolves `CORGI_PANE` through the runtime, so its tab/workspace remain accurate
after moves. `--text` pretty-prints JSON; `pane read --text` emits plain text.

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
errors on stderr, exit 2 for invalid usage and 1 for runtime failures. Focus requires `--viewer` in the CLI. Commands resolve `current` from the calling
pane before sending an explicit target. Shared operations use protocol-1
`session.command`, whose `command` field contains one typed operation, for example:

```json
{"op":"session.command","protocol":1,"command":{"tab.rename":{"target":42,"name":"Build"}}}
```

The daemon has no selected pane/tab and does not calculate headless layout geometry.
`action` and `workspace switch` controls need a live viewer; without one they
return `NoViewer`. Creation uses `tab new --workspace ID` or `pane split ID|current`.
All shared operations use `session.command`; named RPC aliases are not supported.
Tab creation and splitting accept `--command SHELL_COMMAND` to launch a command.
Pane reads return their text in `result.text`.
`agent.rename` (`target`, `name`) and `agent.fork` (`target`, optional `name`)
are the sidebar's agent menu. `agent.rename` without a name, and `agent.fork`
with `check`, only check that they can run now; they fail with `AgentBusy`,
`RenameUnavailable` or `NoConversation` when they can't.

Unwatched panes retain their last dimensions; new headless panes start at 80×24.
Only real viewers supply layout geometry. A saved workspace preference determines
where a new viewer opens, and is never an implicit command target.

Regression suite: `bun test tests/cli.test.ts` uses isolated sockets and provider settings.

## Tabs and panes

`prefix` means press Ctrl+B (or your configured prefix), release, then the next
key. While it waits, a PREFIX bar across the bottom of the panes shows Esc to
cancel, the prefix to send it, and ? for shortcuts. **`prefix ?` opens the full
shortcut screen used in onboarding.**
Press a displayed shortcut or click its label/key to run the action. Esc, Enter,
the Back control, or a click outside dismisses it. Press the prefix twice to send
it through to the child. Resize has its own clickable direction menu.

Section headings and Focus/Swap/Split diagrams organize the active preset.
Both columns scroll together with PageUp/PageDown or the wheel; arrows also
scroll except in tmux, where they focus panes. Below 60 columns the columns
stack. Action keys retain their usual meaning: for example, Corgi j/k focus panes
and q detaches. The prefix and Back control stay visible.

Click **+** after the visible tabs, choose **New tab** from a menu, or press `prefix c` to open the agent picker, which starts an agent or a terminal in a new tab. Unnamed tabs store no name: their displayed numbers are recomputed as tabs move or close. The + button remains visible when tabs overflow. The CLI/control API creates tabs immediately, unnamed unless an explicit title is supplied.

Headers show either the custom name or the automatic number, centered in a minimum width of 10 columns. Narrow terminals clip the active tab as needed while keeping **+** accessible.

**Rename tab** opens a bordered dialog. Type to replace the selection, or move the cursor with Left/Right, Home/End and edit with Backspace/Delete. Ctrl-C, Ctrl-U, or **Clear** empties the field; saving an empty field removes the custom name and restores automatic numbering. The number shown in an empty field is a preview, not saved text. A number you explicitly type is a custom name and stays fixed. Save, Clear, and Cancel are clickable. Cancel leaves the existing name unchanged.

Right-click a tab title for Herdr's tab menu: **New tab**, **Rename**, and **Close**. Actions target the clicked tab; opening or dismissing the menu does not switch tabs. Click a row, press the key on its cap, or use Up/Down (or j/k) and Enter. Escape or a click outside dismisses it. New tab opens the agent picker; Close immediately ends all of that tab's panes.

Every shortcut of every preset, as `corgi keys` prints it. `prefix` is the
prefix key, released before the next one; a key without it is held with its
modifiers. cmux's held keys need [host forwarding](onboarding.md#keys). In resize mode, `h/j/k/l` resize and any other key
exits. Pressing the prefix twice sends it to the pane, so with the Ctrl+A
prefix, `prefix Ctrl+A` types Ctrl+A instead of opening New agent.

| Action | Corgi | tmux | Herdr | cmux |
| --- | --- | --- | --- | --- |
| New tab (agent picker) | `prefix c`, `Ctrl+T` | `prefix c` | `prefix c` | `Cmd+T`, `prefix c` |
| Next tab | `prefix n` | `prefix n` | `prefix n` | `Cmd+Shift+]`, `prefix n` |
| Previous tab | `prefix p` | `prefix p` | `prefix p` | `Cmd+Shift+[`, `prefix p` |
| Select tab | `prefix 1–9` | `prefix 0–9` | `prefix 1–9` | `Ctrl+1–9`, `prefix 1–9` |
| Rename tab | `prefix T`, `prefix ,` | `prefix ,` | `prefix T` | `Cmd+R`, `prefix T`, `prefix ,` |
| Close tab | `prefix X` | `prefix &` | `prefix X` | `prefix X` |
| New workspace | `prefix w` | `prefix N` | `prefix N` | `Cmd+N`, `prefix w` |
| Edit workspace | `prefix W` | `prefix $` | `prefix W` | `Cmd+Shift+R`, `prefix W` |
| Next workspace | `prefix }` | `prefix }` | `prefix }` | `prefix }` |
| Previous workspace | `prefix {` | `prefix {` | `prefix {` | `prefix {` |
| Choose workspace |  | `prefix s` | `prefix w`, `prefix g` | `Cmd+P` |
| Select workspace |  |  |  | `Cmd+1–9` |
| Close workspace |  |  | `prefix D` | `Cmd+Shift+W` |
| Find agent | `prefix g` | `prefix G` | `prefix f` | `Cmd+Shift+P`, `prefix g` |
| Next agent | `prefix ]` |  |  | `prefix ]` |
| Previous agent | `prefix [` |  |  | `prefix [` |
| Last visited agent | `prefix Tab` |  |  | `prefix Tab` |
| Jump to attention | `prefix f`, `F1` | `prefix F` | `prefix o` | `Cmd+Shift+U`, `prefix f` |
| New agent | `prefix a`, `prefix A`, `prefix Ctrl+A` | `prefix a` | `prefix a` | `prefix a`, `prefix A`, `prefix Ctrl+A` |
| Mute / unmute sounds | `prefix m` | `prefix m` | `prefix m` | `prefix m` |
| Focus left | `prefix h` | `prefix ←` | `prefix h` | `Cmd+Opt+←`, `prefix h` |
| Focus down | `prefix j` | `prefix ↓` | `prefix j` | `Cmd+Opt+↓`, `prefix j` |
| Focus up | `prefix k` | `prefix ↑` | `prefix k` | `Cmd+Opt+↑`, `prefix k` |
| Focus right | `prefix l` | `prefix →` | `prefix l` | `Cmd+Opt+→`, `prefix l` |
| Swap left | `prefix H` |  | `prefix H` | `prefix H` |
| Swap down | `prefix J` |  | `prefix J` | `prefix J` |
| Swap up | `prefix K` |  | `prefix K` | `prefix K` |
| Swap right | `prefix L` |  | `prefix L` | `prefix L` |
| Next pane |  | `prefix o` | `prefix Tab` |  |
| Previous pane |  |  | `prefix Shift+Tab` |  |
| Split right | `prefix v`, `prefix %` | `prefix %` | `prefix v` | `Cmd+D`, `prefix v`, `prefix %` |
| Split down | `prefix -`, `prefix "` | `prefix "` | `prefix -` | `Cmd+Shift+D`, `prefix -`, `prefix "` |
| Resize mode | `prefix r` |  | `prefix r` | `prefix r` |
| Resize left |  | `prefix Ctrl+←` |  | `Ctrl+Shift+H` |
| Resize down |  | `prefix Ctrl+↓` |  | `Ctrl+Shift+J` |
| Resize up |  | `prefix Ctrl+↑` |  | `Ctrl+Shift+K` |
| Resize right |  | `prefix Ctrl+→` |  | `Ctrl+Shift+L` |
| Zoom / unzoom pane | `prefix z` | `prefix z` | `prefix z` | `Cmd+Shift+Enter`, `prefix z` |
| Move pane to a new tab | `prefix !` | `prefix !` | `prefix !` | `prefix !` |
| Close pane | `prefix x` | `prefix x` | `prefix x` | `Cmd+W`, `prefix x` |
| Reopen last closed agent | `prefix u`, `Ctrl+Shift+T`, `Cmd+Shift+T` | `prefix u` | `prefix u` | `Cmd+Shift+T`, `prefix u` |
| Scroll / copy mode | `prefix s` | `prefix [` | `prefix [` | `Cmd+Shift+M`, `prefix s` |
| Paste copied text |  | `prefix ]` |  |  |
| Detach | `prefix q`, `prefix d` | `prefix d` | `prefix q` | `prefix q`, `prefix d` |
| Toggle sidebar | `prefix b` | `prefix b` | `prefix b` | `Cmd+B`, `prefix b` |
| Setup | `prefix i`, `prefix C` | `prefix C` | `prefix s` | `Cmd+,`, `prefix i`, `prefix C` |
| All shortcuts | `prefix ?` | `prefix ?` | `prefix ?` | `prefix ?` |

Right-click a pane for its own context menu: rename, clear name, swap with the previously focused pane, split right/down, zoom, or close. Opening the menu does not change focus. Pane names are shared, survive reload/recovery and reopening closed agents, and appear in the focused-pane status line and agent sidebar. An empty name restores the default label. Hold Shift while right-clicking to open the menu over a mouse-aware application.

Drag workspace rows to reorder them, using the horizontal destination marker; release outside the workspace list or press Escape to cancel. Order is shared and saved. Drag agent rows to set a separate order within each workspace. The highlighted ghost occupies the destination slot, and neighboring rows shift to preview the order before you release. Scroll the wheel while dragging to reach offscreen agents. Release outside the agent list or press Escape to cancel. Agent order is shared across viewers, survives reload/recovery, and leaves tabs and splits in place. In the grouped All view, agents stay within their workspace group. Drag the sidebar's right border to change its width, clamped to leave at least 20 terminal columns. Width is local to the viewer and resets on reattach; the workspace/agent division remains halfway down.

Click tabs and panes to focus. Drag split dividers to resize. Drag terminal text to select and copy through OSC 52. Mouse-aware terminal applications, agents included, receive translated clicks, drags and hover through Ghostty; hold Shift to select text instead. Text an application copies with OSC 52 goes to the clipboard of the viewer most recently used on its pane. Right-click opens the pane menu when the terminal application is not handling the mouse. Wheel scrolling enters scroll mode. In scroll mode: `j/k`, Ctrl-U/D, PageUp/Down, `g/G`, `/` literal search, `n/N` repeat, `y` or Enter copies the selection (or viewport), `q` exits. Output keeps running while you scroll.

`corgi action move-tab left|right` reorders tabs. `corgi action join N` moves the focused pane into tab N. New tabs and splits use the workspace default directory.

Exiting a shell immediately removes its pane; an empty tab disappears too. Closing a pane while its agent is running keeps the agent to reopen: each workspace keeps its last **eight closed agents**, with their screen and scrollback, tab name, pane name and working directory. `Ctrl+Shift+T` or `Cmd+Shift+T` in the Corgi preset, `Cmd+Shift+T` in cmux or through the Ghostty integration, or `prefix u` in any preset (or `corgi action undo-close`) reopens the newest one in this workspace in a new tab. The old screen comes back faded under a **Restoring…** band naming the command, and the agent resumes its conversation right away (`claude --resume` or `codex resume`), with the yolo flag if Corgi started it in yolo mode. The band goes away when the agent first draws over the old screen. Resuming a closed agent's conversation from the new-agent launcher reopens it the same way. Closed shells, agents that quit on their own and agents whose session Corgi never learned are not kept, and closing a workspace drops its closed agents. With one workspace, closing the last tab automatically detaches and returns to the outer terminal. Run `./go.ts` to reattach with a new shell, then reopen the agent. Closed agents and native agent sessions remain in the background runtime until it shuts down.

This is an initial implementation of Herdr's core tab/pane operations. Copy mode is intentionally smaller: it does not yet reproduce all of Herdr's vi word motions, keyboard selection, smart-case search, or configurable bindings. Multiple viewers share arrangement and independently select what to view. Limits: 24 tabs per workspace, 64 panes, 16 native provider processes, 10,000 scrollback lines per terminal.

The additive [runtime protocol](development-reloads.md#protocol-1) exposes shared
session snapshots, pane surfaces, and operations with explicit targets for the
viewer-owned UI. The former `attach`/`input`/`size` socket operations have been removed;
`corgi attach` uses `viewer.open` and `viewer.sync`.

New panes run a login shell. To choose it, open **Corgi setup** (click the
corgi badge or press `prefix i`), then **Panes › Shell**: the picker lists
**Default**, each installed shell in `/etc/shells`, and **Other…** for a path.
The choice is the `shell` setting in `settings.json` (beside
`workspaces.json`, default `~/.local/state/corgi/settings.json`), which you can
also edit by hand:

```json
{ "shell": "/bin/zsh" }
```

The setting counts when it names an executable, as an absolute path or a name
on the runtime's PATH. Otherwise, the default is `$SHELL` as the runtime
inherited it, when absolute; then your account's login shell; then `/bin/sh`.
Panes get `SHELL` set to the shell they run. A change applies to panes opened
after it. Clients can use
`corgi rpc '{"op":"shell.configure","protocol":1,"shell":"zsh"}'` (an empty
`shell` clears it); the session snapshot's `shell` field reports the setting,
the shell new panes run and where it came from.

## Agent integration

The left sidebar is split 50/50: workspaces above, agents from the selected workspace below, in tab order until manually reordered. Click + beside workspaces to enter just a name (the focused pane’s current directory is inherited), click a workspace to switch, and right-click for **Rename** and **Close**. Menu actions target the clicked workspace. Close ends its panes and native sessions and removes the workspace; the last workspace cannot be closed. `prefix w` creates, `prefix W` edits, and `prefix {` / `prefix }` switch workspaces. Each workspace retains its tabs; each viewer remembers its focused pane within them. Processes keep running while hidden. New tabs and splits inherit the focused pane’s current directory (a targeted split inherits its target pane’s directory), falling back to the workspace’s default folder when empty; explicit RPC `cwd` overrides it. Changing a default folder does not change existing shells. Workspace names, IDs, and default folders are saved automatically across restarts. Each viewer owns its selection; tabs and processes are not restored after a daemon restart. State lives at `$XDG_STATE_HOME/corgi/workspaces.json` (default `~/.local/state/corgi/workspaces.json`), or beside an explicit `CORGI_SOCKET` as `<socket>.workspaces.json`. `corgi workspace list`, `new NAME [--cwd DIR]`, `switch ID [--viewer ID]`, `edit ID [--name NAME|--clear] [--cwd DIR]`, and `close ID` provide CLI access; close requires an empty workspace with no native sessions. Each entry has two rows: a colored status circle followed by the working directory, then an activity icon beneath the circle and the agent name. The activity icon is blank when idle, 🧠 while thinking, and 🔧 during a known tool call or its approval prompt. Paths under your home use `~`; long paths are shortened from the left so the current directory remains visible. Hook-reported directories take precedence over the foreground process directory; native sessions show their launch directory. Tab names, tool names, and routine lifecycle messages are omitted. An agent nearing compaction ends its first row with how full its context window is; see [Context](agents.md#context).

Right-click an agent in the sidebar for **Rename**, **Fork** and **Close**. Close sits apart below a rule, and the menu never opens with it highlighted. Rename names the conversation in the agent's own records, so Claude Code's and Codex's titles and resume lists show the same name, and it clears the pane's name. Claude renames itself when its messaging socket asks, as Claude's agent view does. Codex renames a session its shared background server runs through that server's socket, mid-turn or with a draft typed. A Codex started without the server (`-c`, `--profile`, `--no-daemon` and similar flags) only hears `/rename`, so Corgi types it, and only into an input box it can see is empty with nothing over it; it never presses Ctrl+C or touches a draft. Otherwise Rename is crossed out. Fork asks for the copy's name, prefilled as "‹name› (fork)", on a card whose picture of a branch splits in two as it opens; the split plays only where the terminal shows Kitty graphics and reports its cell size in pixels (Ghostty and Kitty do), and elsewhere the branch shows at rest. **Create Fork** starts it the way the original was started (`claude --resume … --fork-session` or `codex fork …`), in a new tab with its row right under the original's, and focuses it. Claude takes the name at launch; Codex takes it as soon as its server or its empty input box can. It works mid-turn: the copy ends where the original is, with any running tool call marked interrupted. Fork is crossed out until there is a conversation to copy: Claude's starts with its first message, and Codex's once Corgi knows its id. Close closes the agent's pane.

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

For a running shared Codex daemon, Corgi identifies the CLI's displayed session from its terminal title. At fresh runtime startup, Corgi adds `"thread-id"` to `[tui].terminal_title`, preserving existing items. An unset title uses `["app-name", "thread-id", "activity", "project"]`. Setup uses a temporary Codex app-server process for its config API, without creating a thread or making a model request. Codex parses and edits TOML with a version precondition; Corgi saves `config.toml.corgi-backup` before the first edit and refuses symlink files. Setup errors appear in the status bar and server log. Already-running CLIs must restart to pick up the setting; project/profile overrides can still hide the ID. Corgi resolves the truncated UUID only when exactly one loaded thread matches it, and checks that the title came from the current foreground process.

A separate read-only observer polls the default daemon every 500 ms for selected threads' status and latest turn. It never resumes threads, subscribes to approvals, or changes CLI arguments, shell aliases or CODEX_HOME. Initial attachment establishes a baseline without announcing historical completions; new completed turns update unread receipts and chimes. Multiple turns completed between polls may coalesce into one receipt. Missing/ambiguous titles or an unavailable daemon cannot establish a new binding; stale observations yield to screen detection after five seconds; ordinary hooks and screen detection remain available. Explicit remote or custom CODEX_HOME clients require their own observation source. Codex hooks only update conversations already associated with their claimed pane; they never establish or switch a pane's selected conversation. A daemon or tool inheriting stale pane variables cannot claim a different session through a hook.

The optional launcher and native App Server sessions find Codex automatically: working executables on PATH first, then common user/system installation locations, then macOS app bundles in `~/Applications` and `/Applications` (including Codex and ChatGPT). Candidates must successfully answer `--version`; broken package wrappers, missing binaries, and hung commands are skipped. Run `corgi which codex` to see the selected executable. Legacy pane-launcher symlinks still pass arguments through unchanged and are skipped during discovery to avoid recursion.

Optional explicit `CORGI_CODEX_BIN` / `CORGI_CLAUDE_BIN` overrides remain available for development, set before starting the runtime.

Hooks describe working, waiting, tools, and session identity. `Stop` is provisional: the pane stays working with “checking completion” until the observer confirms the end of that turn. A shared worker checks only pending-stop transcripts, reads bounded appended chunks, backs off when completion is delayed, and never treats silence as completion. Codex requires matching session metadata and turn IDs in `task_complete`/`turn_complete`; Claude uses a fresh, matching-session `system/turn_duration` record after the Stop hook; an Esc during Stop hooks cancels them and leaves a `hook_cancelled` Stop record instead, which ends the turn as interrupted. Assistant messages and stop-hook summaries alone are not confirmation. These transcript formats are provider internals: missing paths, unsupported records, or missing Codex turn IDs leave completion unverified. Native sessions use protocol completion events. Claude sends no hook when a turn is interrupted, so a hook-reported Claude turn becomes idle once its idle title (`✳`) has shown for 1.5 seconds without an "esc to interrupt" hint, or for 250 ms when it follows an Esc or Ctrl-C sent to the pane within the last 5 seconds; a later Stop still starts a normal completion check. Screen-only idle remains an estimate and does not create unread results or completion sounds.

Unread results are independent of working/idle status. Each confirmed end of turn has a monotonic receipt number; a new turn does not erase unread results. A separate sidebar dot remains visible even while the agent works again. Active viewers automatically acknowledge the receipt they displayed when visiting a tab or pane (visible splits count; zoom-hidden panes do not). Background viewers do not acknowledge; terminal focus reporting depends on the host terminal. Receipts are shared across viewers and survive live reload and recovery. Delayed receipts cannot clear newer completions. Reading native events acknowledges that native session. Interrupted/failed turns retain their outcome without playing a successful-completion sound.

The sidebar shows bounded tool/thinking activity, provider-supplied tool descriptions when present, and the most recent completed tool. Generated semantic summaries and background inference are not enabled.

Provider contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks).

## A ding with somewhere to go

- **Needs you:** Herdr's request sound, including in the focused pane; unseen requests retain a sticky `! needs you` marker.
- **Turn finished:** Herdr's completion sound; sticky `+ done` marker.
- `prefix f` visits waiting panes first, oldest first, then completed panes. Visiting acknowledges the marker without changing the agent's actual state.
- Completion sounds stay quiet for a pane focused in any watching viewer. Input requests still ding. Focus reporting depends on the outer terminal supporting it.
- Completion receipts are deduplicated by turn. Duplicate hooks don't ring twice. Bursts are coalesced, with at least 1.5 seconds between sounds and waiting taking precedence.
- Muting suppresses sounds while retaining the attention queue. `CORGI_BELL=terminal` selects BEL; `CORGI_BELL=off` disables client sounds.

The two MP3s are embedded in the binary. Playback runs in a background thread using `afplay` on macOS, or the first successful MP3-capable player on Linux (`paplay`, `pw-play`, `ffplay`, `mpg123`, `mpv`). Temporary audio files are removed after playback; failed playback falls back to BEL. Plain SSH attachments use BEL so the notification reaches the local terminal rather than the remote host's audio device; its audibility depends on your terminal's bell settings.

Sounds play on the attached machine. A detached runtime retains attention markers but does not send desktop notifications. Native protocol sessions also contribute to the attention count; `prefix f` identifies the session and command to inspect it.

## Native agent protocols

For integrations that should not type into a terminal, Corgi can own durable provider processes independently of panes:

```sh
corgi native start codex [--workspace ID]
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

With multiple workspaces, pass `--workspace ID` to `native start`; it never uses a hidden daemon selection.

For Claude, `corgi native start claude` launches its bidirectional streaming CLI with the host permission channel. Send SDK-compatible control/user messages with `native send`, inspect stream events with `native events`. For example, initialize with:

```sh
corgi native send 2 '{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}'
corgi native send 2 '{"type":"user","message":{"role":"user","content":"Explain this project"}}'
```

Native sessions expose protocol messages, not a custom chat UI. Approval/user-input requests remain in `pending_requests` until you send an explicit matching provider response. **Nothing auto-approves.** The event journal retains the latest 128 messages within 4 MiB and exposes `first_seq`/`next_seq` so consumers can detect eviction. Each event's `line` is the original JSON message, encoded as a string. Pending requests are stored separately, so event rotation cannot silently discard an unanswered approval. These are process-local buffers, not disk archives. Provider protocol/version compatibility remains the provider's responsibility; Claude's control channel is less stable than its documented terminal interface.

## Control API

All operations use newline-delimited JSON on a private Unix socket. By default: `/tmp/corgi-UID/control.sock`. Set `CORGI_SOCKET` to select another runtime in its own private directory. Direct `serve` runs the server in the foreground; ordinary startup handles locking and stale socket recovery.

```sh
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split 3 --right
corgi list
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --text
corgi focus 3 --viewer 1
corgi action rename api
corgi action attention
corgi shutdown              # ends this runtime and all its processes
```

`pane send` writes literal terminal input; `--enter` explicitly submits it. It is not a semantic provider RPC. `rpc JSON` exposes the underlying operations used by the CLI. Shared pane and workspace operations use `session.command`; `session.list` lists shared state and `session.locate` resolves a pane's workspace and tab. Viewer navigation uses `focus`, `workspace.switch`, and `action`. Pane and native-session IDs are separate namespaces.

With normal viewers, CLI navigation and actions target the oldest live viewer by default. They are queued and applied on its next update, then acknowledged. Queued viewer actions run in order; a focus followed by a split action uses that focus. To choose another viewer explicitly:

```sh
corgi rpc '{"op":"viewer.list"}'
corgi rpc '{"op":"focus","viewer":2,"pane":3}'
corgi rpc '{"op":"action","viewer":2,"name":"next","value":""}'
```

`viewer.list` reports each viewer's ID and last reported workspace/pane. Unqualified CLI controls target the oldest live viewer; an explicit `viewer` selects one viewer. Shared session data contains no viewer selection. `pane send`, `pane read`, and `pane close` always address the pane ID.

For remote terminals, run Corgi on the host through SSH (`ssh -t host corgi`); the runtime persists there when the connection drops. Provider remoting can also be enabled through the native CLI/App Server interfaces. Corgi itself does not expose an unauthenticated TCP listener.

Cmd+V pastes images from your computer's clipboard into a pane, locally and over SSH, when the terminal supports the Kitty clipboard protocol's paste events (Ghostty nightly on macOS does). Corgi saves the image beside its socket, on the host over SSH (`paste/<hash>.png`, private, removed a day after it was last pasted) and pastes the file's path, which Claude Code and Codex attach. With text on the clipboard too, the text is pasted, as a plain paste would. A viewer asks the terminal once when it attaches. Over SSH, when a paste can't bring an image, a card opens above the focused pane's caret saying why and what fixes it: the terminal lacks paste events (use Ghostty Nightly), tmux sits in between, or Ghostty's `clipboard-read = deny` refuses reads. Ghostty passes its paste key on as a key when it has no text to paste, so the card opens for Cmd+V on macOS and Ctrl+Shift+V on Linux, and for Ctrl+V in an agent pane. Ghostty on Linux has no paste events yet. Its "Ghostty Nightly" link, and the download URL under it, open in your browser with Cmd+Shift-click: Corgi captures the mouse, and Shift tells Ghostty to skip that and open the link itself. A plain click copies the URL, and the card says so. Esc closes the card; a click elsewhere or any other key closes it and goes on. While paste events are on, Corgi refuses text containing an end-of-paste marker, the check Ghostty makes otherwise. Agents' own Ctrl+V still reads the clipboard of the machine they run on. A program that turns on paste events itself gets the paste as its own event instead: Corgi reads the text and image up front and answers the program's read with them, once, for that paste's password; any other clipboard read from a pane is refused. Corgi setup (prefix `i`) shows the state under Ghostty: "Image paste".

## Layout

- `layout.zig`: pure split tree, tab and pane identity, geometry, navigation.
- `pane/terminal.zig`: PTYs, Ghostty parser/render state, selections and search.
- `runtime.zig` / `session.zig`: resource ownership and the typed shared command executor.
- `navigation.zig`: local workspace, tab, pane, and zoom selection.
- `server.zig` / `peer.zig`: daemon loop, socket dispatch, and viewer controls.
- `controller.zig`: viewer input, dialogs, and rendering.
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
