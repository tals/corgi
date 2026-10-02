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
are also hidden. Unknown status (including blocked Keychain access) stays visible,
so usage-access controls remain reachable. A pinned
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
and account columns, a full-row selection highlight, and the destination folder in its footer. Codex
uses `config/read` with that directory and `model/list` for the provider default.
These calls use a separate, lazily started App Server on a background worker;
no thread or inference turn is created. Claude previews `ANTHROPIC_MODEL`, user,
project, local, and local managed settings. Aliases stay aliases; account policy,
trust, and dynamic defaults remain provider decisions. Missing or unreadable
configuration displays `Provider default` instead of guessing a specific model.

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

Account previews use Codex `account/read` without token refresh and Claude's
isolated credential helper, followed by bounded usage/profile requests. Silent
reads never request Keychain interaction; Track usage explicitly permits access.
They show an email, API-key mode, or login status; no credential values are displayed.
Reads are bounded and run on the preview worker.

## Resume a closed conversation

Below the agent rows, the launcher lists the five newest closed conversations
from its folder: provider, title, the last thing you said, and how long ago.
A ✕ marks a turn that was interrupted, and the branch shows when it differs from
the folder's newest conversation. Down from the last agent row moves into the
list; Enter (or a click) resumes the conversation in a new tab, in the folder
it ran in, with that provider's launcher flags such as YOLO. Resuming does not
change which agent `New` starts.

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

The daemon reads conversations on its own worker, so a slow Codex App Server
never delays previews: Claude transcripts by their first 128 KB and a tail that
grows until it holds the last prompt, and Codex threads through `thread/list`
on an App Server that runs only while it reads. Files are reread only when they
change. A first read takes a few seconds; the viewer asks for one when the
launcher opens and shows the list once it arrives, then refreshes it when it is
over 30 seconds old.

`agent.history` returns the conversations. On an `agent.subscribe` connection
the daemon pushes `{type: "agent.history", history}` instead: its last read at
once, marked pending, then a current one. The session command `agent.resume`
(workspace, cwd, provider, session) starts the resumed agent.

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
Files are private and named by credential fingerprints; credentials are never
stored in this cache. Like CodexBar's `ClaudeOAuthUsageRateLimitGate`, Claude 429
responses honor `Retry-After` (seconds or HTTP date), with a five-minute fallback
and a one-minute minimum. Explicit tracking requests do not bypass this gate.
The profile request runs independently of usage, so a usage failure does not hide
account identity. Failed refreshes keep showing the last successful usage reading
without a cache indicator. Its successful-fetch timestamp persists with the value;
retries, profile reads, and reloads do not renew it. At ten minutes old, usage shows
`Unavailable` until a successful refresh. The picker includes the reason, such as
`Unavailable · server returned 429`, an expired access token, or an invalid response.
Recent cached values keep their normal presentation even when a refresh fails.
A credential change uses a separate cache.
Each usage reading is also filed into a per-account history under
`$XDG_STATE_HOME/corgi/limit-history` (or `~/.local/state/corgi/limit-history`),
keyed by provider and account rather than credential, so token refreshes keep it.
It holds the latest reading in each eleventh of a window and feeds the usage
overview's limit sparks; previews carry it as `history`.
