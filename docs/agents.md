# Provider integration

Start with [HACKING.md](../HACKING.md#architecture) for the runtime map.
[Launching agents](agent-launcher.md) and [workspaces](workspaces.md) describe
the user interface. This page covers the contracts behind it.

[OpenCode](opencode.md) describes the v2 adapter and its remaining parity gaps.

## Conversation ownership

The daemon owns one [conversation actor](../src/conversations.ts) per provider
and session ID. An actor holds lifecycle, completion/read receipts, transcript
identity and activity independently of whether a pane currently shows it.

An attachment represents a terminal or headless transport's current selection.
Switching from A to B changes the attachment, not A's identity. Attachments that
select the same actor share its receipts. Before identity is known, screen
observations may supply provisional status and completion receipts. Process
replacement clears the old source associations.

Workers receive snapshots and return observations; the daemon applies them to
the addressed actor after checking identity and generation. Delayed results from
before a selection change must not update its replacement, including A → B → A.
Headless approvals retain their original conversation and transport ownership.

`corgi headless start PROVIDER PROMPT` sends the first prompt and waits for
the provider's session ID. Later `send`, `events` and `stop` commands take
`PROVIDER SESSION`; Corgi does not return another numeric session ID.
Startup stays asynchronous and its pending reply survives live handoff.
The numeric transport handles in snapshots and saved state are internal
bookkeeping for viewer selection and ordering. See [CONTEXT.md](../CONTEXT.md).

`conversation.list` and `session.snapshot` expose actors separately from panes.
Pane acknowledgements include conversation identity and binding generation so
stale selections cannot mark a different conversation read. Runtime-local actor
IDs survive checkpoint restoration but are not globally unique.

## Providers

Each provider is one plain object, `adapter` in
`src/providers/<name>/index.ts`, and everything specific to it lives in that
directory. [providers.ts](../src/providers.ts) lists them in UI order; the
first is the one Corgi offers before the user picks one. Core code asks
`adapter(id)` and never names a provider. A provider calls its own modules
rather than looking itself up. An id is at most 32 lowercase letters and
digits, which is all `corgi-hook` forwards.

[adapter.ts](../src/providers/adapter.ts) is the contract. Every provider says
what it is (names, command, install locations, `programs`), the few `caps` core has
to know, how to read its hooks and launcher commands, how to start, resume,
attach to and fork a session, and how it runs headless sessions, the
tool-less summarizer and its hook integration. Optional members exist only
where a provider has one: a title reader, hook origin, transcripts, an
observer of its own protocol, rename, and the launcher's account and history.
Shared helpers sit beside the contract: the hook codec, screen readings and
watcher, hook settings files, typed command lines and observer snapshots.

Each provider judges its own clues through a `Watcher`, one per provider and
account. It routes each hook to the pane whose conversation it is, since only
the provider knows when a hook names the wrong pane, and reads its panes'
screens for what its hooks leave out: a state before any hook speaks, a
compaction, a turn interrupted without a hook, a prompt answered, a
permission prompt shown. Core keeps what the watcher remembers about each
pane and applies what it decides.

An account is a provider's settings folder, which a variable picks
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); `""` is the one the daemon's environment
picks. [accounts.ts](../src/accounts.ts) knows the default, folders added with
`corgi account add` (made by Corgi, or the user's own with `--dir`), folders an
agent ran in, and the accounts Omarchy lists. An agent's account comes from the
variables its launch keeps, so restores, forks and attaches land in it. Every
adapter member that touches the settings folder takes the account (hooks,
launcher previews, history, the observer, rename and attach), and core keeps
one of each per account it needs.

A folder Corgi makes links the default's setup, as the adapter's
`accounts.shared` lists, and keeps its own login and conversations. Corgi
edits a linked settings file in place, and reads a history folder two
accounts share, as Omarchy's do, once. [signin.ts](../src/signin.ts) frames
the provider's own first run there, reading its screens and asking its own
status check through `accounts.signin`; a provider whose screens don't offer
to sign in again in a folder it ran in names a command that does
(`signin.again`). The viewer draws it over its panes, and `corgi account`
in a terminal of its own. Until that run signs in, the folder sits in a
private temporary folder and its path only links there, because the provider
must only ever see the final path: Claude names its macOS Keychain login
after the path as given. Links the run made into that temporary folder, as
Codex makes to its server, are pointed into the moved folder.

Headless sessions and summaries run through a `Client` the adapter starts,
which runs the provider however it does (Claude and Codex as a child process,
on [stdio.ts](../src/providers/stdio.ts)) and speaks its protocol. Core sends
it `Input`, a prompt, an answer to a request or an interrupt, and takes back
`Event`s: conversations, turns, messages, tools, requests and usage. Provider
JSON never leaves the adapter. A summary is a prompt and the last message
before its turn ends. `save` keeps what a checkpoint or handoff needs, and a
handoff passes the client's `handles` to the next daemon.

A provider's `index.ts` must not statically import a module that imports
`./providers` while loading (discovery, inference, usage, launch). Those load
with `import()`, or loading fails with "Cannot access 'adapter' before
initialization". `providers/sim` exists only in tests; `sim.register()` adds it
so a test finds code that still assumes Claude or Codex. A provider's `info.ts`
lists its `programs`, the executables and scripts that mark its processes; the
daemon hands that table to the native layer at startup. `native/hook.zig`
forwards any provider's hooks; `native/zig/detection.zig` keeps its own copy
of Claude's programs only, to find the Claude process behind a hook, and
`providers.test.ts` checks that copy.

## Resuming and forking

A resume or fork starts the agent with the permission mode and model its hooks
last reported. The resume hint keeps them across reloads and closed agents.
Until a hook reports, an agent the launcher started keeps the launch's yolo
choice.

For an agent typed into a pane's shell, Corgi reads the process's command line
and environment. `launch.keep` saves the options and variables that pick an
account, MCP servers or features, and drops the session, prompt, model and
permission flags. Kept variables, credentials included, go into the 0600
checkpoint and the pane's environment, never onto a command line. Codex's hooks
report any run that never asks as bypassing permissions, so a typed Codex
command's own approval and sandbox options win over a reported bypass. macOS
hides the environment of system binaries, so an agent started through a system
`/bin/sh` script keeps only its options.

## Observations and lifecycle

An external bridge can claim a pane's provider with `corgi claim`
([usage](reference.md#agents-behind-a-bridge)). The claim lives in the pane's
screen tracker and enables the same provider watcher without a local agent PID.
It never selects a conversation, reads local transcripts or supplies a resume
hint; hooks and title-based local reattachment cannot take it over. The local
owner's lifetime bounds the claim. Live handoff keeps it; cold recovery drops its
identity but retains unread receipts.

Identified panes without structured lifecycle evidence share one screen-only
lifecycle, whether identified by a foreground process or a claim. They can
establish work before their first idle screen. A confirmed return to idle after
observed work records a screen-sourced completion, including after a permission
prompt. Startup idle, process exit, claim release and owner loss do not complete
work. First conversation binding adopts provisional screen receipts only into a
fresh actor; late hooks and protocol snapshots do not count that work again.

Hooks, transcript readers, the Codex observer, headless transports and terminal
screens supply different evidence. Fresh structured evidence takes precedence
over screen inference. Once a local process acquires structured lifecycle,
silence does not switch it to screen-only completion. Screens may still
supplement status when protocol evidence ages. This ownership survives live
reload and resets with process replacement. An unavailable source or idle screen
alone is not a completion event.

- A hook `SessionStart` can select a conversation. Later events for a known
  conversation may update it without switching the pane back to it.
- Background Claude processes can inherit `CORGI_PANE`; that alone does not
  authorize them to take over the pane's selected conversation.
- Completion checking validates the transcript's session and turn. A Stop
  hook or assistant message alone is not proof that the turn finished.
- Headless events use explicit conversation identity. A transport exiting does
  not imply that its conversation ended.
- Live reload preserves bindings. Cold recovery preserves identity and receipts
  but requires fresh evidence for active lifecycle state.

Claude can be paused awaiting a background command or scheduled wakeup. Keep
that distinct from completed or awaiting user input. Source-specific handling
belongs in [agents.ts](../src/agents.ts), [observer_service.ts](../src/observer_service.ts)
and the provider adapters, not UI label comparisons.

## Children, usage and context

Parent links must be provider-consistent, deduplicated and cycle checked.
Codex child listings and Claude and OMP subagent observations feed the conversation
registry. Failed discovery must not erase previously known children. Keep child
identity separate from whichever parent a transport currently displays.

OMP's runner supplies the child's display name separately from its role and real
session ID. Its short description can arrive in a later progress event and takes
precedence over the raw assignment. Child transcripts supply usage and evidence,
not replacement names or raw assistant prose for these labels. Hook-driven child
status holds until the next lifecycle event, including through quiet model calls;
it does not expire like a polled child listing. Child hooks are ordered per child,
so a newer parent or sibling event cannot discard a completion. Settled children
leave the active list.

The OMP hook's optional display-name field does not change runtime or saved-state
versions. Reload Corgi and restart OMP to load the updated managed extension.

Three measurements have different lifetimes:

| Measurement | Meaning |
| --- | --- |
| Workspace away counters | New tool/token activity since a focused viewer last watched the workspace. |
| Live usage | Observed input/output for an agent and its descendants; watching does not reset it. |
| Context occupancy | Latest model-call context relative to its reported or inferred window. |

Count each child's own usage once; cached input is part of input, not additional
tokens. Initial transcript history normally establishes a baseline. Missing
history, counter resets or source gaps mean partial coverage (`≥`), not an
invented total; unknown usage remains unknown. These observations are distinct
from provider account rate limits.

Context comes from provider records, not summed lifetime usage. Model aliases
and platform-specific IDs normalize at the provider boundary; unknown IDs stay
recognizable. Provider-specific assumptions and exceptions belong in the
adapters. Live meters are not a durable ledger.

## Checklists

A provider that keeps a task list reports it as a
[checklist](../src/activity/checklist.ts): always the whole list, with the
time it was true. Hook events and transcript readers carry it.
Corgi keeps the newest per conversation, saves it in checkpoints and handoffs,
and never edits it. A provider whose tools change one item at a time folds
those changes into a whole list itself.

The adapter maps the provider's statuses to Corgi's (pending, active, blocked,
done, dropped), names the group of items that come in groups, and builds the
list with `List.of`, which cleans labels and bounds the inventory. A status
it can't read leaves the list partial. A list without its own time takes the
time its hook arrived. Reading a list back from a session is not an edit, so
the list keeps the time of the entry it came from.

The hover card shows the checklist at the bottom under a separate TODOs
heading and full-width divider, without token columns
([checklist_view.ts](../src/checklist_view.ts)). Five items form the main
window. Grouped checklists show each selected group once as a heading, with its
items indented underneath; a checklist with one group or none stays flat.
Items within a group appear as closed, active/blocked, then pending, keeping the
provider's order within each status.

Selection prioritizes active work, then upcoming items; spare rows show the
latest closed items as shared context. Groups with active or blocked work show
"… N done" above their items when multiple earlier completions are omitted.
Only pending omissions get a bottom footer: "+N more pending". Both summaries
require at least two omitted items; a lone done or pending item appears
directly instead, even if this extends the main window. Short terminals keep
recent activity visible and fit items, headings and summaries together without
leaving empty groups. An empty checklist removes the section.

Corgi hides a checklist whose items are all done or dropped 60 seconds after
its time, without deleting it. Pending, active or blocked work keeps the
section visible, and a new edit shows it again. Partial checklists stay visible
because missing items may still be open.

## Inference and data boundaries

Activity summaries, conversation names, worktree briefs and link names share a
private inference worker. Its provider can differ from the agent being observed.
Saved inference settings override environment defaults; [inference/setup.ts](../src/inference/setup.ts)
owns that precedence and [inference/harness.ts](../src/inference/harness.ts) owns
the persistent provider conversations.

Clever Corgi's model picker groups Pi's authenticated chat models under Pi. It
shows five, with “Show N more”, and searches the entire catalog using Manage
Agents' matching rules. Making the Clever Corgi pane visible starts asynchronous
discovery without holding the daemon request queue. All viewers and background
requests share a three-minute throttle, cleared when accounts are added, removed
or renamed. First loads show “Fetching models…”; cached models keep their labels
and counts with a quiet refresh indicator. A failed refresh retains the previous
catalog. Account changes during discovery discard stale results and restart it.
Pi's own refresh-enabled auth check filters stale OAuth
and unavailable credentials; a catalog entry alone is not proof of sign-in.
These probes disable extensions, tools and context and create no saved session
or model turn. API-key readiness is not a paid-request health check.

The picker uses colored agent headings, flush account headings, and tree branches
only beside model rows. Identity and billing stay in separate columns; known plan
tiers are shown directly, with Plan, Metered, Free or Unknown otherwise. Missing
identities stay blank; a login for one model provider never labels another.
Named accounts and plan tiers remain searchable. Agent and account headings
stay pinned beneath search. The model marked “(auto choice)” in the identity
column and its account stay visible even when browsing another provider in that
agent's catalog.
Codex and Claude discover each account's complete model list through their
read-only control channels, without a model turn. Each account starts with five
models ranked by known price estimates; unknown prices sort last. “Show more”
reveals the rest. Chat-model settings never choose private-inference defaults.
An explicit pick carries that account's folder and model through inference;
choosing Auto again clears the account override. Native Auto stays on the
default account rather than silently switching to another metered login.

Pi's “Auto (model name)” prefers recognized subscription-backed access, then
catalog prices estimated for four input tokens per output token. Missing or
unpriced zero costs are unknown, not free. Auto's resolved model and account are
not saved as preferences and can change on a later catalog refresh. An explicit
pick saves its model and account independently of Pi's chat settings; it never
silently substitutes another model if that login becomes unavailable. Summaries,
link names, conversation names and worktree briefs all use that selection.
The defaulted selection, catalog and account fields extend the wire and handoff
snapshots without changing protocol or saved-format versions.
Known plan tiers add a defaulted display field to the transient catalog; older
catalog records normalize it to empty, without a protocol or saved-format bump.

Requests carry bounded current evidence. Activity summaries receive commentary
and tool descriptions, not tool output; link naming can include visible terminal
text. Conversation names use at most 2048 bytes of the initial user request,
never tool output or assistant commentary. Only untitled root conversations
attached to live Corgi panes, of providers without automatic titles, opt in;
explicit names always win. Pending name requests can be reconstructed after
handoff; applied names use the actor's
existing saved name. Pi's prompt hook supplies bounded opening text directly,
without image data, so naming need not wait for a transcript or assistant reply.
Older extensions fall back to the transcript; an absent or empty file retries
promptly without using the model-error backoff. Worktree briefs use commits and a
trimmed diff. Names and summaries are model guesses, never lifecycle
evidence or verified page titles.

Helper conversations must remain outside the visible agent registry and produce
no attention notifications. The harness restricts provider tools and MCP access;
unexpected approvals fail requests. Timeouts and protocol failures discard the
affected conversation. Callers must tolerate lost model history and validate
returned text before applying it to the current actor/turn.

Hook installation edits provider configuration atomically, keeps backups and
preserves unrelated settings. Corgi adds its hooks to every account it knows
when it starts and before it launches an agent in one; an agent typed under a
new folder reports from its next start.
Account previews use provider interfaces; Claude owns its credentials and login
UI. See [agent-launcher.md](agent-launcher.md) for account behavior and
[reference.md](reference.md) for inspecting or uninstalling integrations.

Summary diagnostics contain private evidence in the runtime's local `server.log`.
Checkpoints contain retained terminal output. Crash reporting is a separate
release-build facility; see [debugging](../HACKING.md#debug). Do not treat these
files as safe public attachments.

## Tests

Use adjacent unit tests for reducers, stale observations, receipts, usage and
provider decoding. [tests/provider_sim.ts](../tests/provider_sim.ts) supplies
controlled provider doubles for process-level scenarios, including reordered
events; they are not complete vendor emulators.

[tests/README.md](../tests/README.md) owns build/run commands. Relevant suites
include `conversations`, `codex_titles`, `subagents`, `activity_summary`,
`inference_reload` and `reloads`. [evals/README.md](../evals/README.md) covers
optional live summary evaluation. Ordinary tests do not contact models.

## Pi

Pi 1.0.0 or newer is supported. Corgi discovers `pi` on PATH (or
`CORGI_PI_BIN`) and installs `extensions/corgi.js` under
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`. Installation leaves settings and
other extensions alone. `--no-extensions` disables reporting unless that
file is explicitly loaded with `-e`.

Pi accounts use separate `PI_CODING_AGENT_DIR` folders. Manage agents can
add or rename them, and each keeps its own hooks, model settings, history,
and resume locations. New accounts share skills, prompts, themes, model
definitions and key bindings; settings and extensions stay private. Corgi
refuses to modify an imported account's symlinked extensions directory.
Guided sign-in opens Pi: type `/login` and choose a
model provider. Corgi checks that provider with `pi auth check`. Removing
a Corgi-managed account removes its local credentials; imported folders
are only forgotten. The launcher shows the saved account identity without
a cache-status suffix; saved credentials alone do not verify sign-in.

Pi supplies terminal lifecycle, tools, blocked dialogs, context and token
usage through its extension and session records. `agent_settled`, after
retries and queued work, ends a Corgi turn. Pi 1.0 lacks settlement's
`aborted` flag; assistant stop reasons and an observed Escape supply it.
Corgi also supports session history, resume, fork, rename, headless RPC,
private tool-less summaries and live transport handoff. Corgi names untitled Pi
conversations running in its panes from their opening request, using its configured
inference model. Pi running outside Corgi is never automatically named.
Connected extensions save the suggestion into Pi too, only if it is still unnamed;
older or unavailable extensions keep the name local to Corgi. Turn inference off
to disable automatic naming. Activity summaries use current-turn transcript commentary and tools independently of the
hook activity shown as a fallback.

History follows Pi's session-directory environment variable and global
setting. Sessions observed in Corgi record their exact file and account in
`corgi-history/` under the default Pi configuration directory, so per-command
`--session-dir` and project settings remain discoverable and resumable.
When accounts share a session directory, observed sessions retain their
account; unobserved sessions appear once, under the default account when
it shares that directory, otherwise the first registered account.

The launcher asks Pi's RPC state for its effective model and display name.
This offline probe disables extensions, tools and context files and does
not save a session. If the probe fails, Corgi falls back to cached settings
and its model-name formatter; the provider-qualified launch ID stays intact.

Pi's project-trust flag is not a tool-permission bypass. Its launcher has
no YOLO toggle; permission extensions keep their own policy. For OpenAI Codex
OAuth accounts, Corgi asks Pi for a refreshed bearer token and reads ChatGPT's
subscription usage endpoint. Usage shares the launcher's cache, cooldown and
ten-minute expiry. Other providers do not report quota in the launcher; saved
OAuth credentials alone do not verify sign-in or remaining quota.
Extension-defined subagent relationships are not exposed through a standard
interface, so Corgi does not invent them.

Headless prompts received while busy are follow-ups. Stop waits for prompt
acceptance, clears the queue, then aborts. Dialog answers use `message` for
text or a selected option; confirmation uses `allow`. Timed-out dialogs
are removed. Inference disables discovered extensions, context, skills and
tools; a requested JSON schema is a prompt constraint, validated by the caller.

Opt-in live checks use the configured Pi OAuth account and Luna:

```sh
bun tools/pi_live.ts /absolute/path/to/pi/dist/bundle/cli.js
bun tools/pi_live.ts /absolute/path/to/pi/dist/bundle/cli.js --account
bun tools/pi_rpc_live.ts /absolute/path/to/pi/dist/bundle/cli.js
```

The terminal check uses a disposable configuration and runtime; the RPC
check saves sessions only in its disposable directory. Both consume model
usage. The provider enum and defaulted provider maps expand in the schema
snapshots; existing wire and saved fields retain their meanings.

## Oh My Pi

Oh My Pi (`omp`) is a fork of Pi with its own extension events, RPC
details and folders; Corgi supports it as a separate provider, `omp`, that
reuses Pi's code where the two still agree. Corgi discovers `omp` on PATH
(or `CORGI_OMP_BIN`) and installs `extensions/corgi.js` under
`${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}`. omp reads Pi's variable for its
agent folder, so a value meant for Pi moves omp into Pi's folder, where the
two extensions would claim the same `extensions/corgi.js`. Corgi records the
omp sessions it sees in `corgi-omp-history/`, apart from Pi's.

omp runs the extension for every subagent session in its process. Only the
pane's own TUI session reports terminal lifecycle; child factories relay
nested task lifecycle without selecting their sessions in the pane.
Runner events link subagents by their real session IDs, with type, task
description and transcript, so their status and usage appear in the
subagent count and hover card. Child factories register identity before
their lazy transcript exists; extension-free children become identifiable
once their transcript header is available.

A terminal `agent_end` ends a Corgi turn. `willContinue` keeps it active
unless it only awaits background work: then the idle parent shows the pause
icon until it resumes. Interrupted or failed turns do not acquire that pause,
even if children continue. Tool approvals, plan reviews and the `ask` tool
show as needing input. Dialogs another extension opens don't. Automatic
compaction uses paired start/end events. Manual compaction and background
summary preparation are not reported: omp has no matching end event on
cancellation or failure. The extension never handles `session_before_compact`,
which would switch off omp's background compaction.

omp names its sessions itself, in a title slot at the top of each session
file and in `title_change` records, so Corgi follows those names and never
suggests one. Renames from Corgi go through the extension. Forks use omp's
`--fork`, which takes no name; Corgi renames the fork once it appears.
Resume passes the session file Corgi saw, or the ID, which omp looks up.

The hover card keeps activity history and token totals together. Empty child
lists have no footer, and child totals have no "Live usage" label.

omp's `todo` tool supplies the [checklist](#checklists). Its phases become
groups; `in_progress`, `completed` and `abandoned` read as active, done and
dropped. The extension sends the list after each successful edit. On session
start, switch and branch it reads the list on the current branch back from the
session, timed by the entry that holds it, so a finished list doesn't return.
Transcript catchup restores missed edits without overwriting newer hook
updates. OMP's own HUD visibility doesn't affect the card.

OMP activity comes from its native tool intents, not Corgi's inference worker.
The extension forwards `i` while tool arguments stream, so a write's intent
appears before its file content finishes generating. Execution-start intents
and child progress update the same activity history; revisions of a streaming
intent amend its current entry. Missing intents retain the last semantic note,
never a raw tool or path label. OMP's headless transport and transcripts also
supply native intents; older transcript records cannot replace a newer live
label.

Activity updates do not change working, approval or compaction state. Other
providers still use Corgi's activity summaries. Restart already-running OMP
sessions after installing the updated integration to load the streaming hook.

The launcher reads the default model from omp's RPC state, falling back to
`modelRoles.default` in `config.yml`. omp keeps sign-ins in `agent.db`; the
launcher shows the one for the default model's provider and reads its limits
from `omp usage --json`. Adding accounts from Corgi isn't supported yet: omp
keeps several sign-ins per folder already. Bypass maps to `--auto-approve`.

Headless sessions and Clever Corgi both use `omp --mode rpc-ui`, which lets
headless tools ask questions through Corgi. Inference disables tools and
extensions, so it needs no UI interaction. A run ends at `session_settled`,
after queued prompts and background work. Stop sends
`abort_and_restore_queue`, so withdrawn prompts never run.

OMP support keeps runtime and viewer protocol 3 and management protocol 1.
Provider entries and the checklist default when reading existing records, so
checkpoint and handoff versions are unchanged and no saved-state migration is
needed. Older peers ignore provider names they do not know.

```sh
bun tools/omp_live.ts
bun tools/omp_rpc_live.ts
```

Both use the signed-in default model and consume model usage; the terminal
check copies the sign-ins into a disposable configuration.
