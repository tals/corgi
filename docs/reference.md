# Using Corgi

Corgi keeps terminals and agents running in workspaces. Each workspace has a
folder, tabs and split panes. Start with the [installation guide](../README.md);
building and working on Corgi are covered in [HACKING](../HACKING.md).

## Set up and import

Run `corgi` to start or attach. `corgi onboard` reopens setup; inside Corgi,
click the corgi badge or press **prefix i**. Choose a shortcut preset and a
Ctrl+B or Ctrl+A prefix. The cmux preset is available on macOS.

**prefix** means press the prefix, release it, then press the next key.
Press it twice to send it to the program. **prefix ?** opens the current
keymap; **Corgi setup → Keymap** changes it. Command shortcuts need host
forwarding. Setup can install a Ghostty configuration block on local macOS;
it affects Ghostty globally and requires a Ghostty configuration reload.

The import step lists real sessions, regardless of the shortcut preset.
Select workspaces and review what will happen before importing, or choose
**Skip import**. Expanding a workspace's preview does not change its selection.

| Source | What comes across | What happens to the source |
| --- | --- | --- |
| tmux | Folders, window names, split layout and recent output; editable restart commands where available | Programs keep running in tmux. Corgi opens shells; suggestions do not run automatically. |
| Herdr copy | Layout, folders and known agent resume suggestions | Source sessions keep running. Suggestions do not execute automatically. |
| Herdr handoff | The whole source session, including its running processes and PTYs | Ownership moves to Corgi. Start Corgi outside the Herdr session being moved. Requires compatible Herdr support. |
| cmux (macOS) | Saved workspaces, readable surfaces, folders and approximate layouts where needed; browser URLs as text | Processes remain in cmux. Corgi starts new shells. |

Copying cannot transfer arbitrary application memory or a shell's environment.
Import notes identify partial recovery; a failed import does not complete setup.
Even an isolated Corgi environment imports from real source sessions.

## Tabs and panes

**prefix c** opens the [agent and terminal picker](agent-launcher.md).
**prefix N** creates a workspace; choose its name and folder, then hold Enter
to create it. Missing folders can be created from the folder picker.

Click a tab, pane or sidebar agent to focus it. Drag split dividers to resize.
Right-click tabs, panes and agents for their actions; hold Shift when an
application captures the mouse. Drag workspace rows to reorder them.

The agent list defaults to manual order, as dragged. New agents go on top,
or first in their existing linked worktree group. Choose Sort: By activity
in the "agents: … ▾" menu to group agents by what they are doing: working
(including those waiting on you, in warm, and paused ones), ready to read,
idle and done. A new agent stays dimmed in working through startup and idle,
until its first prompt starts work. Each section keeps the order you drag it
into; an agent that enters one goes on top. Agents next to each other in a linked worktree share a ⌥
label, and ⌥ main marks where they stop. Click a section's header to fold it;
done starts folded. Right-click an agent and choose **Star** or **Unstar**
(`s` while the menu is open). Starred agents stay in the top **★ starred**
section as their activity changes. Dragging only reorders agents within
their section; it never stars or unstars them. Stars and order are shared
and saved with the workspace; they don't move panes. Stars follow conversations
when closed and resumed in that workspace, and show beside their titles in
its new-tab history.
Sort: Manual in the "agents: … ▾" menu keeps the dragged order and marks starred
agents with ★. Starring does not change the selected sort.
The default sort stays out of the preferences file until you choose a sort.

Use **prefix w** to choose a workspace, **prefix a** to choose an agent, and
**prefix g** to search agents in the Corgi preset; in the focused agent list,
`/` searches and Esc returns to the list. Arrow focus crosses between
the sidebar, panes and review panel. **prefix b** hides or shows the sidebar.
[Workspace activity and worktrees](workspaces.md) explains its indicators.

Drag terminal text to copy it; hold Shift over mouse-aware applications.
The wheel enters scroll mode. There, `j/k`, PageUp/PageDown and `g/G` move,
`/` searches, `n/N` repeat the search, `y` or Enter copies, and `q` exits.
Output continues while you scroll.

Closing a tab or pane ends its processes. **prefix u** reopens the latest
recoverable closed agent in the workspace, resuming its conversation; closed
shells and unsaved application memory cannot be restored. **prefix q** detaches
this viewer and leaves the runtime running.

Viewers share processes and layout but keep their own selection and zoom.
A pane takes its size from the last-used viewer displaying it; other viewers
clip or pad it. Hidden panes keep their last size.

After a crash or reboot, Corgi restores saved layout and output. Recorded agent
sessions return dormant and resume when their pane gets focus; other panes
start new shells. Recovery cannot restore arbitrary process memory. See
[reload and recovery details](../HACKING.md).

### Customize shortcuts

Open **prefix ?**, then **Ctrl+E**, or **Corgi setup → Keymap → Customize**.
Use `/` to filter by action or key, arrows or Tab to select a shortcut, and
Enter to edit it. Click an alternate to edit that exact binding; `+` adds
another. **Ctrl+L** hides or shows alternatives. The `◇` symbol means your
prefix; direct bindings have no diamond. All text uses ordinary terminal
cells, including the stacked Focus and Swap keycaps.

Help caps at 112 columns and adapts to the available space. Focus and Swap
stack when necessary while keeping their directional arrangement. In very
narrow terminals, Panes follows Tabs before the remaining sections. Long
bindings wrap, and a scroll indicator marks content outside the visible area.

Every edit opens a compact dialog. Controls use unfilled outlines, color,
and bold, with a green focus marker. Short or narrow terminals use a denser
layout. Arrows move between controls; Enter chooses. Select a binding chip
to edit that alternative, or `+` to add another. **Use prefix** toggles whether
the shortcut follows the prefix or runs directly. Record a shortcut to capture
its modifiers. `◇` denotes the prefix and `⇧` denotes Shift.

For **Select tab** and **Select workspace**, the Keys dropdown offers numeric
and function-key ranges (`[1..9]`, `[F1..F9]`), or an arbitrary ordered set recorded one key at a
time. Enter finishes recording a set; Backspace removes its last key. Only
key sets have a separate modifier dropdown: Ctrl, Alt and Shift toggle
independently with Space, Enter or a click. The menu stays open for multiple
changes. A dash means only some keys have that modifier; toggling it applies
it to the whole set. Dropdowns open below their fields; Esc closes a dropdown
first, otherwise it cancels the entire edit.

**Remove** or Backspace deletes the selected binding and selects the next
remaining binding. Keep pressing Backspace to clear the action. Ctrl+Z or
Cmd+Z undoes removals one at a time. **Save** applies all edits to the action;
**Cancel** discards them. **Use defaults** restores the action's preset bindings;
Save applies the restoration. The defaults row stays hidden when the bindings
already match the preset, without moving the controls or resizing the dialog.
A conflicting key
shows its current owner before **Move** saves it. A member of an indexed set
cannot be reassigned separately.

Overrides live in `$XDG_STATE_HOME/corgi/viewer.json`, normally
`~/.local/state/corgi/viewer.json`. Add a `keys` object to the existing file:

```json
{
  "preset": "corgi",
  "prefix": "ctrl_b",
  "keys": {
    "new": ["prefix+y", "ctrl+alt+n"],
    "split:right": "prefix+v",
    "tab": "prefix+1..9",
    "close": []
  }
}
```

An omitted action inherits the preset. A string replaces all its shortcuts;
an array supplies alternatives; `[]` unbinds it. Action names are those used
by `corgi action`; append an argument with a colon, such as `focus:left`.
`tab` and `goto-workspace` each describe a complete indexed set. Numeric and
function-key ranges expand in order. For another layout, use an explicit set:

```json
{ "tab": { "keys": ["prefix+&", "prefix+é", "prefix+'"] } }
```

Each key in that set selects the corresponding tab, starting with tab one.
Use a literal single character, or `space`, `enter`, `tab`, `backspace`,
`insert`, `delete`, `home`, `end`, `pageup`, `pagedown`, an arrow name, or
`f1` through `f25`. Spell a literal plus as `plus`. Modifiers are `ctrl`,
`alt` (`opt`), `shift`, and `cmd` (`super`). Unmodified uppercase ASCII letters imply
Shift. Escape and the configured prefix key are reserved.

Bindings follow the logical characters received from the terminal, so a set
can use the characters on your keyboard instead of assuming a US number row.
They do not track physical key positions after changing layouts. Some key
combinations require terminal forwarding or an enhanced keyboard protocol;
for example, legacy terminals cannot distinguish Ctrl+I from Tab or Ctrl+M
from Enter. The recorder shows what Corgi actually receives. Command/Super
also requires host forwarding. Its toggle appears only for an existing or
recorded Command binding; ordinary modifier choices do not assume support.

Valid edits reload in open viewers. Invalid JSON, unknown actions and
conflicting custom shortcuts leave the working bindings active. A custom shortcut
replaces an ordinary preset binding only when both its chord (key and modifiers)
and prefix mode match. Direct and prefixed shortcuts coexist. Indexed sets must be
changed as a whole. Viewers refuse to save over a malformed file or a stale
editor. If you unbind help, run `corgi action keybindings` from a pane to reopen
the editor. Remove an action's override to inherit its preset again.

### All shortcuts

These are the preset defaults printed by `corgi keys`; the interactive help shows your active overrides. Keys without `prefix` are held
with their modifiers. In resize mode, `h/j/k/l` resize and another key exits.
tmux tab numbering starts at zero; other presets start at one.

| Action | Corgi | tmux | Herdr | cmux |
| --- | --- | --- | --- | --- |
| New tab (agent picker) | `prefix c`, `Ctrl+T` | `prefix c` | `prefix c` | `Cmd+T`, `prefix c` |
| Next tab | `prefix n` | `prefix n` | `prefix n` | `Cmd+Shift+]`, `prefix n` |
| Previous tab | `prefix p` | `prefix p` | `prefix p` | `Cmd+Shift+[`, `prefix p` |
| Select tab | `prefix 1–9` | `prefix 0–9` | `prefix 1–9` | `Ctrl+1–9`, `prefix 1–9` |
| Rename tab | `prefix T`, `prefix ,` | `prefix ,` | `prefix T` | `Cmd+R`, `prefix T`, `prefix ,` |
| Close tab | `prefix X` | `prefix &` | `prefix X` | `prefix X` |
| New workspace | `prefix N` | `prefix N` | `prefix N` | `Cmd+N`, `prefix N` |
| Edit workspace | `prefix W` | `prefix $` | `prefix W` | `Cmd+Shift+R`, `prefix W` |
| Next workspace | `prefix }` | `prefix }` | `prefix }` | `prefix }` |
| Previous workspace | `prefix {` | `prefix {` | `prefix {` | `prefix {` |
| Choose workspace | `prefix w` | `prefix s` | `prefix w`, `prefix g` | `Cmd+P`, `prefix w` |
| Select workspace |  |  |  | `Cmd+1–9` |
| Close workspace |  |  | `prefix D` | `Cmd+Shift+W` |
| Find agent | `prefix g` | `prefix G` | `prefix f` | `Cmd+Shift+P`, `prefix g` |
| Choose agent | `prefix a` |  |  | `prefix a` |
| Next agent | `prefix ]` |  |  | `prefix ]` |
| Previous agent | `prefix [` |  |  | `prefix [` |
| Last visited agent | `prefix Tab` |  |  | `prefix Tab` |
| Jump to attention | `prefix f`, `F1` | `prefix F` | `prefix o` | `Cmd+Shift+U`, `prefix f` |
| New agent | `prefix A`, `prefix Ctrl+A` | `prefix a` | `prefix a` | `prefix A`, `prefix Ctrl+A` |
| Mute / unmute sounds | `prefix m` | `prefix m` | `prefix m` | `prefix m` |
| Focus left | `prefix ←`, `prefix h` | `prefix ←` | `prefix h` | `Cmd+Opt+←`, `prefix ←`, `prefix h` |
| Focus down | `prefix ↓`, `prefix j` | `prefix ↓` | `prefix j` | `Cmd+Opt+↓`, `prefix ↓`, `prefix j` |
| Focus up | `prefix ↑`, `prefix k` | `prefix ↑` | `prefix k` | `Cmd+Opt+↑`, `prefix ↑`, `prefix k` |
| Focus right | `prefix →`, `prefix l` | `prefix →` | `prefix l` | `Cmd+Opt+→`, `prefix →`, `prefix l` |
| Swap left | `prefix H`, `prefix Shift+←` |  | `prefix H` | `prefix H`, `prefix Shift+←` |
| Swap down | `prefix J`, `prefix Shift+↓` |  | `prefix J` | `prefix J`, `prefix Shift+↓` |
| Swap up | `prefix K`, `prefix Shift+↑` |  | `prefix K` | `prefix K`, `prefix Shift+↑` |
| Swap right | `prefix L`, `prefix Shift+→` |  | `prefix L` | `prefix L`, `prefix Shift+→` |
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
| Review changes | `prefix e` | `prefix e` | `prefix e` | `prefix e` |
| Setup | `prefix i`, `prefix C` | `prefix C` | `prefix s` | `Cmd+,`, `prefix i`, `prefix C` |
| All shortcuts | `prefix ?` | `prefix ?` | `prefix ?` | `prefix ?` |

## Review changes

**prefix e** opens the review panel for the focused pane's checkout. Press it
again to focus the panel, and a third time to close it. Esc returns to the pane;
drag the panel's left edge to resize.

| Task | Key |
| --- | --- |
| Review commits and uncommitted changes together | Default view |
| Compare the working copy with HEAD | `u` |
| Pick one commit | `g` |
| Move between file list and diff | Tab |
| Move between hunks | `[` / `]` |
| Search / toggle wrapping | `/` / `w` |
| Select lines / add a note | `v` / `c` |
| Paste notes into the pane / copy notes | `s` / `y` |
| Pin the checkout while changing agents | `p` |
| Show all review keys | `?` |

The default comparison includes changes since the branch diverged from the
default branch. On that branch, it includes work not yet pushed.
**Review changes** on a worktree heading starts a Reviewer agent there and
pins the panel to that checkout.

Pasting notes does not press Enter. For a pane without bracketed paste,
such as a bare shell, notes are copied instead. Notes belong to the viewer
and disappear when it exits. The panel reads Git without modifying the
repository; binary and oversized files show a notice instead of a diff.

## Script Corgi

Commands print text; `--json` prints the daemon's reply as JSON instead. Take
IDs from `corgi list`. `current` means the pane running the command, not UI focus.

```sh
corgi list
corgi tab new --workspace 1 --name Tests --command 'bun test src'
corgi pane split current --right
corgi pane read 3 --lines 100
corgi pane send 3 --stdin --enter < /path/to/prompt.txt
corgi pane idle --cwd /path/to/project --first
corgi launcher hide codex claude/work --workspace 1
corgi focus 3 --viewer 1
```

`pane send` types literal input; `--enter` submits it. `pane close` and
`tab close` terminate their target processes without prompting. Layout changes
do not focus a viewer; `focus` requires an explicit `--viewer` from `list`.
`pane idle` lists the panes whose shell waits at its prompt, by workspace then
tab; `--cwd` and `--workspace` narrow them and `--first` stops at one.
`launcher hide` and `launcher show` take agents out of one workspace's launcher
or put them back, as Manage agents' **Show in** column does; `launcher list`
says what each workspace shows.
Commands do not implicitly start a missing runtime.

When a coding agent (Claude Code, Codex, Cursor, Gemini CLI, Copilot, or one
that sets `AI_AGENT`) runs these commands through a pipe, `pane read` trims
line ends, shortens rules and collapses blank runs. `--agent` and `--no-agent`
force it either way, as does `CORGI_AGENT_MODE=1` or `0`.

`corgi --help` always lists all commands. Use `corgi pane read --help` or
`corgi help pane read` for a command's syntax, or `corgi --skill` for the
[bundled scripting guide](../assets/corgi-skill.md).
[Agent internals](agents.md) covers hooks and headless provider sessions.

### Agents behind a bridge

A local SSH, container or Slurm wrapper can identify the agent its pane shows:

```sh
#!/bin/sh
corgi claim claude --owner "$$"
trap 'corgi claim --clear --owner "$$"' EXIT
ssh -t compute-node claude
```

`claim` enables that provider's existing screen watcher; it does not launch an
agent. The pane defaults to `CORGI_PANE`, or use `--pane ID`. The owner defaults
to the CLI's parent process; `--owner PID` names the long-lived local bridge.
Only that owner can change or clear a live claim. A claim disappears when its
owner exits or the pane ends. Claims survive live reload, not cold recovery.

Run these commands where `CORGI_SOCKET` is reachable: normally the local
bridge, not the remote shell. Screen inference supplies status and completion
notifications when observed work returns to a confirmed idle screen. It can pick
up an agent already working; initial idle alone does not complete a turn.
Autodetected local agents use the same screen-only lifecycle until hooks or the
provider protocol take ownership; a quiet structured source does not switch back
to inferred completion. Screen-only observations are marked as screen-derived,
not backed by remote transcripts, usage, conversation identity or local resume
commands. Clearing a
claim or losing its owner does not complete a turn or erase existing unread
receipts.

## Settings and troubleshooting

Prefer **Corgi setup** for changes. **Panes → Shell** selects the shell for new
panes; **Theme** changes appearance; **Clever Corgi** controls model-backed
features and Smart Links. Settings and launcher commands survive restarts.
Its Pi section shows “Auto (model name)” and five signed-in models, with “Show N
more”. Type to search all models, including the hidden ones. Auto is resolved by
Corgi, preferring subscription-backed access, and does not pin a model in saved
settings; an explicit pick does. Neither changes Pi's normal chat model.

For a standard runtime, state lives under `$XDG_STATE_HOME/corgi`, defaulting
to `~/.local/state/corgi`:

| File or folder | Purpose |
| --- | --- |
| `viewer.json` | Setup completion, keymap, appearance and worktree folder preferences |
| `workspaces.json` | Saved workspace configuration |
| `settings.json` | Runtime settings, including shell and inference choices |
| `recovery/` | Saved layout, terminal output and agent recovery context |
| `account-previews/`, `limit-history/` | Each account's latest usage reading, and its limit and spend history |
| `accounts.json`, `accounts/` | Provider accounts besides the default, and the folders Corgi made for them; shared by every environment. A new one waits in a private `corgi-account-*` folder in the temporary directory until it's signed in |

An explicit `CORGI_SOCKET` selects another runtime; its workspace/settings
files live beside the socket. Viewer preferences remain shared. Developer
environments can isolate these paths; see [HACKING](../HACKING.md).
Saved inference choices override inference environment defaults.

| Symptom | First check |
| --- | --- |
| A shortcut goes to the terminal or does nothing | Open `prefix ?`, check the preset and prefix, then check host key forwarding. Reload Ghostty after setup changes its bindings. |
| Mouse selection or links do not work | Hold Shift for terminal selection; use Cmd+Shift-click for Ghostty's native link handling on macOS. |
| Image paste fails, especially over SSH | Open **Corgi setup → Terminal capabilities**. The paste notice identifies missing terminal support, tmux interference or clipboard permission. Text paste is independent. |
| An agent is missing or status is wrong | Run `corgi which codex` or `corgi which claude`, then `corgi integration status`. Codex hooks need trust in `/hooks`, once per account; newly installed hooks need a new agent session. |
| An agent in a second account doesn't show its usage or history | `corgi account list` shows the accounts Corgi knows and who signed in; `corgi account add claude NAME --dir FOLDER` adds a folder it doesn't. |
| Usage says Unavailable | Check the provider's login and the reason shown in the launcher; usage failures do not necessarily prevent launching. |
| Installed Corgi seems out of date | `corgi update status` shows installed/running versions; `corgi update --check` checks for a release without installing it. |
| A release needs reverting | `corgi update rollback` switches to the retained previous release, when available. |

Update commands apply to installed releases. Development or unmanaged builds
use the workflow in [HACKING](../HACKING.md).

For remote work, run `ssh -t host corgi`; detaching or losing the connection
leaves the runtime on that host. Image paste and sound behavior depend on the
outer terminal; plain SSH uses the terminal bell for notifications.

For a bug report, include `corgi --version`, OS, terminal, whether SSH/tmux is
involved, and the shortest reproduction. The runtime's `server.log` sits beside
its socket (normally `/tmp/corgi-UID/server.log`). Logs and recovery files can
contain conversation and terminal contents; inspect excerpts before sharing.
Use the [sandbox and UI driver workflow](../HACKING.md) for reproducible UI cases.
