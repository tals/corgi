# New agent launcher

The agents heading has a split `New ▾` button. `New` opens a new interactive
agent tab in the focused pane's directory (or the workspace directory when
empty), repeating the provider last used in that workspace. A workspace that
has used none repeats the last provider used anywhere. Codex is the initial
default. The choice is shared by viewers and retained by live reload and disk
recovery.

Hover over the button for an immediate preview, or click the arrow to keep the popover
open. Choose Codex or Claude Code to launch and remember that provider.
Providers that are not installed are hidden: the daemon checks `CORGI_CODEX_BIN`
/ `CORGI_CLAUDE_BIN`, `PATH`, and the usual install locations without running
anything, and skips previews for missing providers. Providers confirmed signed out
are also hidden. Unknown status, including failed account checks, stays visible. A pinned
popover supports Up/Down, Tab/Shift-Tab, Home/End, Enter, and Escape.
Below the providers, a `New terminal` row opens a plain shell tab in the same
directory; press t in the popover to open one directly. Pressing Cmd+T (the prefix, then c) or Ctrl+T again
while the popover is open also opens a terminal. It does not change the
remembered provider.
Arrow keys stop at the first/last row; Tab cycles. Navigation keys also activate
a hover-opened popover. Escape keeps it dismissed until the pointer moves. Clicking outside dismisses it.
A hover preview accepts a, A, or Ctrl+A to launch; other ordinary typing goes to the terminal. Opening a preview never sends a prompt.

Press Ctrl+B, then a, A, or Ctrl+A to open the preview. Press any of those again to launch
the selected agent, or use arrows to select another provider first. The preview
starts on the row this viewer last left selected in the workspace, else the
workspace's provider; a new workspace starts on the last row used anywhere. The next-tab binding is unchanged. Jump to attention is now Ctrl+B, f.

The compact popover shows one row per provider with aligned agent and model
and account columns, a full-row selection highlight, and the destination named in its title
(see [Worktrees](#worktrees)). Codex
uses `config/read` with that directory and `model/list` for the provider default.
These calls use a separate, lazily started App Server on a background worker;
no thread or inference turn is created. Claude previews `ANTHROPIC_MODEL`, user,
project, local, and local managed settings. Models show their names, as in
[Model names](agents.md#model-names). Aliases stay aliases, so `opus` shows as
"Opus" with no version; account policy, trust, and dynamic defaults remain
provider decisions. Missing or unreadable configuration displays
`Provider default` instead of guessing a specific model.

Usage stays on that same row. Each reported limit groups its window, usage bar,
percent used, and reset countdown, with `·` before the countdown and `│` between
limits. A missing limit is omitted; a reported zero remains visible. Unknown
reset times display `unknown`. Cached readings use the same presentation. Bars
shrink away on narrow terminals, with account/model/plan columns yielding space
before the usage text is clipped.

Viewers keep an `agent.subscribe` stream for the active directory, including while
the picker is closed. The daemon sends the cached preview immediately, refreshes
subscribed directories every sixty seconds, and pushes changed snapshots. Opening
the picker reads the viewer's latest snapshot without requesting data. Directory
changes select a new subscription; daemon reloads retain the last displayed values
until fresh reads complete. A first uncached read can still show `Reading…`.
Account and usage reads share a separate credential-scoped cache with a sixty-second
minimum interval across directories, viewers, and daemon processes. Interactive launches use
Corgi's existing discovered-binary launcher and ordinary provider settings,
without overriding models or adding a prompt. Each provider row has an independent
YOLO checkmark (click it, or press y for the selected row). It defaults off and
stays set across viewers, live reload, and disk recovery. Toggling keeps the
menu open and does not launch an agent. New and keyboard launches use that
provider's remembered setting. When enabled, Codex receives
`--dangerously-bypass-approvals-and-sandbox` and Claude Code receives
`--dangerously-skip-permissions`; when off, ordinary provider permissions apply. They do not use the
small-model status inference settings.

The protocol exposes `agent.subscribe` (workspace and cwd) on a dedicated connection,
which receives `{type: "agent.preview", cwd, preview}` messages. The one-shot
`agent.preview` operation remains available. The session command
`agent.create` (workspace, optional cwd, optional provider). Omitting provider
repeats that workspace's choice. The session snapshot and checkpoint include
`last_agent`, the latest choice anywhere, with a Codex default for older data,
and each workspace's `last_agent`, null until an agent starts there.

Account previews use Codex `account/read` without token refresh and Claude
`auth status --json`. Claude quota reads use a persistent, isolated headless CLI
with `initialize` and `get_usage` control requests (`skip_behaviors: true`). No
model prompts, tools, hooks, MCP servers, saved sessions, or status-line commands
are used. Claude handles credential storage and any authentication UI itself;
Corgi does not read tokens or Keychain entries.

Account checks are shared across directories for one minute. Public quota readings
are cached per account/profile across reloads; refreshes are at most once a minute,
with five-minute backoff after failures. Unsupported or malformed usage replies
preserve the detected account and the last reading's original age. The experimental
control protocol may be unavailable on older Claude versions; that does not hide
the agent. Reads are bounded and run on the preview worker.

## Worktrees

The title says where agents start: “New agent in ⌥ topic”, naming the Git
checkout by its branch (without a leading `worktree-` or `worktree/`), or
“New agent in finance” for a folder outside a repository. Nothing else in the
launcher repeats it; the conversations' heading says “3 here”. Off the
comparison branch (usually `main`), the ⌥ and the branch turn warm. It starts
where the agent list puts the focused agent: one started on main that works
in a worktree, and is listed under it, opens the launcher in that worktree.

The panes behind the launcher dim, and the agent list keeps lit only where
the agent will go, as browsing a worktree in the overview does: in a linked
worktree, its group; in the main checkout, the workspace's own rows, its
worktree groups fading; for a new worktree, nothing yet.

In a checkout the name sits on a button with a `w` keycap. Press w, or click
it, for one box: the workspace's checkouts, the primary one first, with ✓ on
the current one and its agents and uncommitted files at the right (“2 agents ·
3 changed”, “clean”); then, a blank row down, a **New worktree** rule carrying
an `n` keycap and the form under it. The box opens with the caret in the
form's Branch; Up from there goes to the last checkout, just above the form.
Up/Down move along the checkouts, Enter or a click chooses one, w or Escape
closes the box. Choosing a checkout moves the launcher there: the model
preview, the conversations and `t` follow it.

The form has Branch, the new branch's name (a typed space becomes `-`); From,
what it starts from, the comparison branch (usually `main`) to begin with; and
Folder, `./.worktrees/login` under the project's main checkout unless Corgi
setup says otherwise (see below). n, Down past the last checkout, or a click
puts the caret back in Branch, and the rule lights up. Escape closes the box
from the checkouts or the form alike. Tab or Down moves to From, whose list
opens right under the field, as wide as it and on its background: the
repository's local and remote branches, newest commit first, with each one's
age. Typing filters them, names starting with the text first; Up/Down pick,
Enter or Tab takes one and goes back to Branch, and Escape only dismisses the
list, keeping the old one. The daemon lists them (`git.branches`) when the box
opens; one that can't offers `main` and the current branch. Enter on Branch
takes the form. Names Git won't take, and branches checked out already, are
refused there. The title then names the new branch, and the footer says “new
worktree from main · new tab”.

Nothing is created until something launches. An agent, a saved command or a
terminal has the daemon run `git worktree add -b <branch> <folder> <base>` on
its own connection first, then starts in the new folder; the footer says
“adding ./.worktrees/login…” meanwhile. A branch or folder that exists
already opens the box back on the form with the reason, and nothing launches. Escaping
the launcher leaves no worktree behind. A worktree inside the main checkout
would show there as untracked, so its top folder (`/.worktrees/`) goes in the
repository's `.git/info/exclude`, which isn't committed, unless Git already
ignores it.

**Corgi setup › Source control** sets where new worktrees go, as a template
the viewers share in their preferences (`worktree_folder` in `viewer.json`):
`$PROJECT_ROOT/.worktrees/$NAME` by default. `$PROJECT_ROOT` is the project's
main checkout, `$PROJECT_NAME` its folder's name, `$NAME` the new branch with
`/` as `-`, and `$HOME` or a leading `~` the home folder; `${NAME}` works too.
A relative folder is relative to `$PROJECT_ROOT`, and a `./` typed at the
start becomes `$PROJECT_ROOT/`. `../$PROJECT_NAME-$NAME` puts them beside the
project.

The pane is a box that takes typing once it has focus, with the folder it
makes for a branch `fix-login` of one of your projects under it, and each
variable's value there below. Variables show green, mistakes amber. A template
Corgi can't use says why in place of the folder, and Enter doesn't save it: an
unknown variable (“$BRANCH isn't a variable; did you mean $NAME?”), lowercase
(“Variables are uppercase”), a `$` or `${` left open, or no `$NAME`. Enter
saves, Esc drops the edit, and an emptied box saves the default it shows. A
hand-edited template that doesn't parse falls back to the default.

## Resume a closed conversation

Below the agent rows and a rule, the launcher lists the five newest closed
conversations from its folder: provider, title, the last thing you said, and how
long ago. The provider is named once per run of rows: a line continues it down
the rows below, and the next name marks a switch. A scrolled list or a new day
names it again. A ✕ marks a turn that was interrupted, and the branch shows when it differs from
the folder's newest conversation. Down from the last agent row moves into the
list; Enter (or a click) resumes the conversation in a new tab, in the folder
it ran in, with that provider's launcher flags such as YOLO. Its sidebar row
shows at once, asleep, and the corgi digs out a **Restoring…** band over a blank
screen until the agent has drawn and settled. A closed agent that undo could
reopen comes back as undo brings it back instead: with the command that started
it, its old screen faded under the band, and in its old tab place when it
closed in this workspace. Resuming does not change which agent `New` starts.
A Claude conversation that Claude's background daemon still runs, such as one
sent there with `/bg`, opens with `claude attach` instead, since `claude
--resume` refuses it; closing its tab leaves it running there. Corgi checks the
records live Claude processes keep in `~/.claude/sessions/` at that moment.
Saved launcher commands still resume, since they may use another account.
When an agent Corgi started exits with an error, as a refused resume does, its
tab stays with its last screen and `# Exited with code N` until you close it.

**Show N more…** or `/` expands the list into a table grouped by day. `/`
searches titles, first prompts and last messages; every word must match. Tab
widens the scope from this folder to the workspace to everywhere. Search lists
conversations a pane already runs first; Enter goes to that pane instead of
starting a second copy of the session. Esc clears the search, then collapses the
list.

The list holds Claude transcripts and interactive Codex threads that contain a
prompt and whose folder still exists, since a Claude session resumes only from
its own folder. Running conversations, SDK runs, subagents and sessions continued
under a new id are left out, and so are conversations that only asked for a
commit (`$commit-all`), which search still finds. Claude Code keeps transcripts
for 30 days by default; Codex keeps its threads.

The daemon keeps the list current on its own worker. It reads everything once
when it starts: Claude transcripts by their first 128 KB and a tail that grows
until it holds the last prompt, and Codex threads through `thread/list` on an
App Server that runs only while it lists. After that it rereads only what
changes. `fs_watch.zig` watches `<claude config>/projects` and the Codex home
(FSEvents on macOS, inotify on Linux), and a busy transcript is reread once
its writes settle for a second. A new Codex thread or a rename lists the most
recent page of threads again. With nothing changing, the worker sleeps. Where
watching cannot start, it rereads everything every five minutes.

Viewers follow the list instead of asking for it, so opening the launcher does
no work. The daemon sends each viewer the whole list once, then only the
conversations that changed or went away. The launcher keeps the list it opened
with, so rows never move while it is open. The viewer adds what Corgi knows
about conversations it ran: the name its sidebar showed, and when it last saw
or closed them, so a conversation you just closed comes first.

`agent.history` returns the list. With `follow` on an `agent.subscribe`
connection, the daemon pushes `{type: "agent.history", update}` messages
instead: `update.full` replaces the list, otherwise `entries` replace those
with the same provider and session and `removed` drops some. The session
command `agent.resume` (workspace, cwd, provider, session) starts the resumed
agent. With `asleep`, its tab opens hibernated, named `name`, and the agent
starts once its pane is focused.

## Manage agents and saved commands

Choose **Manage agents** on the launcher's title, or press m, for a table of Show checkboxes, agent
names, accounts, and **Edit** buttons. The inline command field below the table
is focused by default. Paste a command; a name is suggested from the provider
and model. Permission behavior appears in the YOLO column. Press Tab to edit the
name, then Enter or **Add**
to save. Names persist across edits, hide/show, and reloads. **Edit**
loads a command into that same field; editing a built-in creates a custom command
and hides its default row after saving. **Done** returns to the picker. Use **Delete** beside a saved command to remove it. Clearing an edited command
and saving also deletes it. There is no hiding
hotkey. Preferences and commands are shared by viewers and survive reload and
recovery. Up to six custom commands can be saved, each up to 2048 bytes.

For example, `FOO=123 claude code --whatever` is saved as shell source, preserving
inline environment assignments, quoting, arguments, and provider options. Saving
and previewing never execute the agent command. After a 350 ms typing pause, Corgi loads the
detected shell configuration and reads alias/simple forwarding-function
definitions in a background worker and previews the expansion below the field.
The preview also summarizes the model and permission behavior. With no explicit
auth override it uses the provider account preview. Explicit API keys/tokens,
endpoints, config overrides, and named profiles are distinguished from that
default account; unknown identities remain unknown. Explicit Codex homes and
Claude config/home paths can provide a cached public email, labeled `(cached)`.
These local identity hints are not a live token-validity check.

Add/Save stores that exact preview; it waits for resolution if pressed early.
Editing the draft invalidates older results. Fish resolution uses the actual function
body, not potentially stale `--wraps` metadata. For example, `cc` becomes
`command claude --allow-dangerously-skip-permissions --dangerously-skip-permissions`.
The `command` prefix bypasses later alias/function changes. An unchanged draft, hide/show, repainting,
and launching never resolve the saved shorthand again. Editing and saving new
source resolves it again. Complex functions are rejected rather than executed
or guessed; paste their underlying launch command instead. Simple commands are labeled by their
recognized provider, including commands behind `env`, `bunx`, or `bun x`. Unknown
commands remain usable; custom profiles are not filtered using the default
provider account, because inline environment settings may select another account.

Corgi detects the shell from `SHELL`, falling back to the user's passwd
entry and then `/bin/sh`. Saved commands use an **interactive, non-login shell**
(`-ic`), loading bash's `.bashrc`, zsh's `.zshrc` (respecting `ZDOTDIR`), or fish's
normal configuration. The debounced draft preview uses that configuration to resolve aliases and
simple forwarding functions. Launches evaluate the saved command and its ordinary variable
expansions in the selected working directory. Alias/function definitions
must be in the shell's startup configuration; definitions made only in another
running shell are not inherited. Passive process discovery identifies the actual
Codex/Claude process after the saved command starts it. Saved commands use
their own supplied options; built-in YOLO toggles do not rewrite them.

The session commands `agent.visibility`, `agent.command`, and
`agent.command.create` manage visibility, saved source, and launching respectively.
Snapshots/checkpoints include `agent_hidden` and `agent_commands`, defaulting to
visible built-ins and no saved commands for older data.

The manager separates Command and Name into bordered fields. The compact preview
shows provider/account and explicit model or permission overrides; Show command
reveals the frozen expansion. Cancel clears the draft. Original shorthand is
saved separately so a name-only edit reuses the frozen expansion. The new-agent
picker shows numeric keycaps starting at 0 for visible agents and a left-side
`t` keycap for a plain terminal.

Custom commands use the same picker columns as built-in agents. Their account
comes from the saved command preview; commands using the default account share
its current plan and usage preview. Separate profiles do not inherit those values.

Account preview metadata and request deadlines persist under
`$XDG_STATE_HOME/corgi/account-previews` (or `~/.local/state/corgi/account-previews`).
Files are private; credentials are never stored in this cache. Claude cache names
hash the executable, config directory, and public account identity reported by the
CLI. Logins without a public email remain launchable but do not share cached quota
readings. Claude usage failures back off for five minutes across directories and
reloads. Account status is checked independently, so a usage failure does not hide
account identity. Failed refreshes keep showing the last successful usage reading
without a cache indicator. Its successful-fetch timestamp persists with the value;
retries, account reads, and reloads do not renew it. At ten minutes old, usage shows
`Unavailable` until a successful refresh. The picker includes the reason, such as
`Unavailable · Claude usage request unsupported` or `request timed out`.
Recent cached values keep their normal presentation even when a refresh fails.
An account or config-directory change uses a separate Claude cache.
Each usage reading is also filed into a per-account history under
`$XDG_STATE_HOME/corgi/limit-history` (or `~/.local/state/corgi/limit-history`),
keyed by provider and account rather than credential, so token refreshes keep it.
It holds the latest reading in each eleventh of a window and feeds the usage
overview's limit sparks; previews carry it as `history`.
