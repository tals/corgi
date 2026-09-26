# Workspace activity

The workspace's second line uses the same colors and attention icons as the agent list:

- Yellow `N●`: working agents; green `○` with no number when none are working. The indicator uses a three-column slot so idle, single-digit, and two-digit counts align.
- Red, bold `N●`: agents blocked or needing input.
- Teal, bold `N unread`: unread agents.
- `N⚒`: reported tool calls while away.

Tool counts are right-aligned and stay visible even at zero. Token usage is still tracked in workspace stats but is not shown in the sidebar. The unread count remains visible, including zero, when away statistics appear. Working counts are omitted when space is tight. The full unread label and needs-input count take priority. All counters stay within the two-line workspace entry. Working, attention, and unread are live agent counts; tool and token counters clear when a focused viewer opens the workspace and stay clear while any focused viewer watches it. An unfocused window or detached viewer does not suppress activity when the terminal reports focus changes. If another viewer still reports the workspace as focused, its counters remain cleared. Counters are shared across viewers and saved with runtime checkpoints.

Ordinary Codex and Claude sessions use incremental, session-validated transcript reads on a background worker. Codex's existing read-only daemon observer supplies its transcript path; Claude hooks supply theirs. Native sessions use their existing provider event stream. Tool calls count once per reported call ID, not once per start/result event. Token reports are deduplicated using cumulative totals or message IDs. Input includes reported cache reads/writes; output includes reasoning where the provider includes it in output totals. These are activity counters, not a billing estimate or context-window measurement.

Counting begins when Corgi binds an observable session. Existing transcript history establishes a baseline and is not counted as new activity. Usage is attributed when the provider reports it, so streaming token totals may arrive in batches. Missing transcripts, records larger than 1 MiB, and provider formats that omit usage cannot supply complete totals. Known Codex children are followed recursively; their subsequently reported activity contributes to their workspace. Reloading preserves displayed away totals but seeds a new transcript baseline, so events written during the handoff may be omitted.

No setup beyond `./go.sh` is required for an already observed session. To see away totals accumulate, select another workspace in every viewer watching it, then let its agent do new work. Returning clears those totals.

Hover over an agent's name, activity, or subagent badge to inspect one combined
card: its own activity and token spend, followed by children grouped by role or
activity with individual spend and group totals. These live meters keep
counting while you watch the workspace and reset only when the daemon reloads or
restarts. A `≥` marks partial coverage. See [Live children and usage](agents.md#live-children-and-usage)
for discovery, ownership, and catch-up semantics.

## Agent activity summaries

Agent entries reserve their first line for the name and their second line for
current activity. Long names clip with an ellipsis instead of occupying the
activity line. Codex and Claude summaries are 2–3 words prioritizing currently
running tools, then recent completed calls, with the latest assistant update
and original request as context. The
existing transcript reader supplies turn-scoped tool progress independently of
workspace away counters. Claude can show provider descriptions before its first
summary; native sessions are not summarized.
The prompt targets 2–3 words; short labels of up to six words are also accepted
instead of leaving the activity blank. Longer labels and control characters are rejected.

For Codex, pending transcript tool calls and live background tasks also drive the
wrench icon. A yielded build keeps the wrench until the process finishes, even
after its launch call returns. Background task descriptions join summary evidence.

The first inference runs as soon as nonempty evidence is available, including
commentary without tools or a tool start without commentary. Changed evidence,
including tool starts and completions,
queues a refresh, with an eight-second cooldown and a one-second global minimum
between calls. Updates coalesce to the latest snapshot during the cooldown;
unchanged polls do not query inference. Duplicate call IDs and historical
transcript records do not advance tool progress. Up to 64 pending calls and 256
completed IDs are retained. Evidence includes at most four live pending tools
and short descriptions of the latest three completions; tool outputs are not
sent to the summarizer. Missing transcripts
no longer prevent commentary-based summaries.

A single background worker coalesces updates. Results are checked against the
session, turn and commentary generation; more tool completions during inference
do not discard a still-relevant result. The protocol sends stored activity text
separately from lifecycle state. Hooks update tool indicators without replacing
summaries with tool names or generic thinking labels. The client chooses status
labels and animations from that state, including the sleeping corgi
for idle agents. While awaiting a first result, the activity text stays blank; the
working indicator remains visible. Failures keep the activity text blank or retain
the last valid label and retry after 60 seconds.

Every summary attempt writes JSON request/result records under `activity_summary`
in the runtime's private `server.log`. Records correlate by daemon PID and request
number and identify the actor, attached pane IDs, agent name, session, and turn.
The request contains the exact instructions and serialized input sent to inference;
the result contains the exact returned text and validation result or error reason.
An inference failure records a null output and its error. Detached actors have an
empty pane list. These diagnostics include private conversation evidence, like
recovery snapshots, and remain local to the runtime log.

Compaction takes priority over inferred activity and records a `Compacting context`
phase in the recent timeline. Hooks report its start and end; for Codex sessions
observed through the daemon, the live terminal's compaction status supplements the
protocol's working state. Summaries arriving during compaction are retained for
afterward without replacing the current phase. The compaction entry remains in
the bounded history when work resumes.

Corgi's own inference runs through a persistent native harness, reusing the
existing login: Codex's App Server (it does not run `codex exec`) or Claude
Code's JSONL transport. The observed agent's provider and the inference provider
are independent.

By default the provider is **Auto**: until a harness has answered once, Corgi
uses whichever agent you have launched most in panes since the runtime started
(ties go to the most recent launch; with no launches yet, the last agent Corgi
remembers). Once a harness answers, Auto keeps it until you change the setting,
so a Claude Code user gets Claude-backed summaries and link names without
installing or signing in to Codex.

Click the corgi badge at the top of the sidebar, or press **Ctrl-B i**, to open
**Corgi setup** and choose Auto, Codex, Claude, or Off (arrow keys and Enter, or
click a row; Escape closes). The popover shows what Auto picked and the launch
counts behind it. Changes apply immediately, stop the previous harness, and are
saved in `settings.json` beside `workspaces.json`. A saved choice wins over the
environment. Clients can do the same with
`corgi rpc '{"op":"inference.configure","protocol":1,"choice":"claude"}'`; the
session snapshot's `inference` field reports the choice, provider, model,
whether Auto has settled, and launch counts.

Without a saved choice, `CORGI_INFERENCE_PROVIDER` (`auto`, `codex`, `claude`,
or `off`) sets the starting choice. Unknown values disable inference rather than
silently sending data to a different provider. GPT-6 Luna (`gpt-6-luna`) with
low reasoning effort is the Codex default; Claude Haiku 4.5
(`claude-haiku-4-5-20251001`) is the Claude default. The setup popover shows the
model beside each provider. `CORGI_INFERENCE_MODEL` overrides the model for either provider;
`CORGI_SUMMARY_MODEL` remains a legacy fallback. `CORGI_INFERENCE_BIN`
optionally selects the native harness executable; otherwise the normal
`CORGI_CODEX_BIN` / `CORGI_CLAUDE_BIN` discovery applies. The old one-shot
`CORGI_SUMMARY_COMMAND` executable protocol is removed; its `off` value is still
honored. Environment settings take effect when the server starts; a reload
preserves the existing server environment, and launch counts restart.

The shared `src/inference.zig` module accepts instructions, bounded content, an
optional JSON Schema, and an optional conversation key. It returns bounded UTF-8
text (JSON for schema requests); callers validate task-specific semantics such
as word counts. Each actor owns one status-inference conversation, keyed by its
stable actor ID rather than its current turn or pane. Accepted results checkpoint
the last four bounded evidence/label pairs on the actor. This context survives
turn changes, detachment, and harness eviction, and accompanies current evidence
when a native conversation must be recreated. New snapshots explicitly replace
prior activity; history is background context only. The daemon applies results
to the actor after checking its current session, turn, and evidence generation;
workers receive value snapshots and never mutate actors.

The pool retains at most four conversations/processes and evicts the least
recently used conversation when full. A conversation resets after 32 requests.
Codex reuses its process when replacing a conversation, including repeated fresh
requests; after 32 created conversations the process itself is recycled. Claude
keeps one process per retained conversation; fresh history requires replacing
that process. Native history is ephemeral and best-effort: eviction or failure recreates the
conversation with the actor checkpoint. Server restart clears both. Other callers
must provide enough current evidence to recover without earlier history. This first version uses a process per retained Codex
conversation too; multiplexing threads through one process is not required by
the caller interface and can be added internally later.

Inference reuses the native transport with a private conversation registry, so
helper agents never become visible agents or produce attention notifications.
Codex runs read-only with shell, apps, hooks, plugins, code mode, and memories
disabled; configured MCP servers are disabled before creating a thread. Claude
uses safe mode with built-in tools and MCP servers disabled, preserving login.
Pane/hook identity environment variables are removed. Unexpected approval
requests fail the request. The worker imposes a 45-second deadline; cancellation,
protocol errors, and failed turns destroy the affected conversation. The next
scheduled request can recreate it. All retained processes stop with the worker.

Deterministic native-harness fixtures cover reuse, separate histories, fresh
Codex threads, eviction, crashes, timeouts, output limits, and structured output.
An optional live check performs two tiny requests and verifies retained context:
`CORGI_TEST_LIVE_INFERENCE=codex ./scripts/zig build test` (or `claude`). It consumes
provider usage; regular tests never contact a model.

## Workspace link names

Confirmed browser links show `Open ... ↗` while their name is queued or being
inferred. The three stationary dots have a subtle blue glimmer; the title
replaces them when it arrives. The shared inference worker tries to name the
destination from the owning pane's visible terminal text,
terminal title, working directory, workspace name, process name, PID, and URL.
For example, it can change the shortcut to `Open Finance ↗`. It sends at most
1,600 bytes of visible terminal text and bounded metadata; it does not ask the
model to fetch the page or inspect other panes.

Names are cached for the endpoint's workspace, pane, PID, port, scheme, and bind
address. Successful names stay stable while that endpoint remains present.
Unknown names and failures show `Open Link` without glimmer and retry after a
minute. Inference-disabled links also use `Open Link`. Removed
endpoints invalidate queued work and late results. Up to 64 endpoints are named;
others retain the fallback. Link requests and activity summaries alternate on
the same worker and share its five-second global throttle and inference settings.

Multiple URLs with the same inferred name share that name on the shortcut.
Different names retain the generic shortcut; the chooser shows each name beside
its URL. Actual URLs, hover previews, remote-host selection, and click behavior
are unchanged. Names are guesses, not verified page titles.
# Background commands in the agent tooltip

The tooltip groups provider-owned shell tasks under Tests, Builds, Servers, and
Commands. Each row is one task identity, so shell wrappers and worker processes
do not inflate the list. Labels use a compact provider description when available
(at most six words / 48 bytes), otherwise a short action summary such as Running
tests or Watching output. Raw command lines, flags, and inline programs are not
used as fallback labels. Categories use only the invocation prefix; unrecognized
commands stay in Commands.

Codex uses the optional read-only `thread/backgroundTerminals/list` endpoint.
Unsupported or failed reads omit the inventory without changing agent lifecycle.
Claude uses shell entries from the existing Stop hook's `background_tasks` array,
including its descriptions. These hook snapshots are marked Last reported;
they are not a continuously polled process census. Missing arrays retain the last
report, empty arrays clear it, and SessionEnd clears it. Older Claude versions
without this field cannot populate this section. No process controls are added.

The inventory is bounded to 32 tasks and the tooltip to eight rows, with explicit
overflow. Codex observations older than ten seconds also become Last reported.
