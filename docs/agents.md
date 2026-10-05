# Conversations and provider integrations

The daemon owns one `conversations.Actor` for each `(provider, session ID)`.
An actor retains lifecycle, completion/read receipts, transcript reference, and
activity metadata even when no pane selects it. Its identity never changes.
`Runtime.conversations` owns stable heap allocations; worker threads receive
value snapshots and return observations addressed to actor IDs. The daemon is
the only writer of actor state.

`conversations.Attachment` represents a provider UI's current selection. Terminal
panes and native transports each have an attachment. Selecting B after A changes
the attachment, leaving A intact. Two attachments selecting A share its receipts
and acknowledgements. Before identity is known, an attachment can hold provisional
screen status. Replacing its foreground process clears its source associations.

`providers.Provider` names the agents Corgi integrates with; a pane running
anything else has no provider (`null` in snapshots). Each provider's `info`
(`src/providers/<name>.zig`) holds its static facts: executables and install
locations, the arguments for native sessions, the inference harness and resume,
configuration and account files, credential variables, flags, where its
rate-limit response keeps usage, and the few properties several modules share,
such as `prompt_turns` and the terminal screen signals that detection reads.
`providers.Backend` dispatches hook/native envelope decoding and title parsing.
Per-provider values that viewers see, such as inference launch counts, use
`providers.Each`, keyed by provider name.

Formats that differ in code rather than data (transcript records, usage
accounting, native protocols) use exhaustive `switch` statements, so adding a
provider fails to compile until each one is handled.
Transport ownership stays in `native.Session` or the terminal pane. Screen
detection and the read-only Codex observer remain separate sources; a future
provider can reuse the sources it actually supports.

## Observations and switching

- Hooks select on `SessionStart`. Later events for a conversation known to that
  attachment update that actor without changing selection, unless the selected
  conversation has ended; then any event but `SessionEnd` selects it. Claude
  processes outside their terminal's foreground job, such as daemon-hosted
  sessions or a `claude -p` an agent runs from a tool, inherit `CORGI_PANE` but
  never select. A first hook can also
  establish identity on a fresh attachment before process detection identifies
  the provider. After process replacement, this requires fresh provider detection
  or a `SessionStart` hook.
- Codex title resolution carries the pane's process ID, title revision, and
  attachment generation. Results from before a switch are rejected, including
  A→B→A. Repeating or decorating the same conversation title leaves its revision
  unchanged. Identified active conversations can continue being polled after selection
  changes. Idle detached conversations are retained but not continuously polled.
- A Claude Stop pauses a conversation that waits to be woken by a Monitor it
  started or a one-shot wakeup it scheduled (ScheduleWakeup, a `/loop` tick);
  the sidebar shows `‖` in place of `○` or `●`. Background shell commands
  don't pause it: Claude wakes for them too, but nothing says it is waiting on
  them. The pause ends with the next hook or conversation line in the
  transcript; once the transcript reports each Monitor it waited on ended
  (stopped from Claude's task list, which wakes nothing); or once the Claude
  process that sent its hooks exits, which the daemon checks every second. A
  hook that names no Claude process never pauses.
- Transcript, summary, and usage workers address actors rather than panes.
  Transcript readers retain their position while rotating a bounded set of open
  files. Completion confirmation can therefore finish after a pane switches away.
- Native events use their explicit conversation identity. Approval requests retain
  their original actor, and completing a request in one transport does not clear
  another transport's outstanding requests. Transport exit does not end the actor.
- The snapshot's `observed_at` reports the last observation time. An unavailable
  source is not a completion event. Cold recovery marks non-ended lifecycle state
  unknown while preserving identity and receipts; live reload preserves bindings.
  Fresh protocol evidence takes precedence over screen inference. After protocol
  evidence expires, screen observations continue tracking changes until structured
  evidence returns; a screen result never makes itself authoritative.

## Queries and persistence

`session.snapshot` now includes `conversations`, independently of `panes` and native
`sessions`. Each conversation has a runtime-local ID, optional parent ID, workspace,
last observation time, attachment count, and agent state. A pane's `agent.conversation`
and `binding` identify its selected actor and selection generation.

`conversation.list` returns the conversation views. `conversation.acknowledge`
accepts `conversation`, `through`, and optional `attention_at`. Pane acknowledgements
also accept `conversation` and `binding` so viewers can reject stale selections.
Existing native transport controls and raw terminal input retain their interfaces.

Checkpoint version 2 stores actors once and attachments as ID references. Version 1
pane-local state migrates on import. Actor IDs survive checkpoint restoration;
they are not globally unique. The registry currently retains up to 1,024 actors.
Networking and endpoint qualification belong to a separate remoting layer.

## Live children and usage

The Codex observer retains the identities from each known conversation's child
listing and follows active children recursively. Parent links are verified,
deduplicated, and cycle checked. A failed listing does not erase known children.
Finished children remain in the registry for the runtime's lifetime, so their
activity and usage remain inspectable. Native Codex thread metadata can establish
the same links without changing the transport's selected parent.

Hovering anywhere over either line of a sidebar agent for 500 ms opens one
viewer-local details card. The name, activity, and subagent badge all open the
same card. It starts with the agent's own activity and token usage, including
agents without children, then groups descendants by reported role or current
activity. It shows group counts, individual activity/status, token totals, cached
input, output, and roughly five minutes of recent spend. Group totals sum each child's
own usage; the overall total adds the parent's own usage once. The existing
working/blocked badge still describes direct children. When none are active, the
badge retains the count of known descendants so their details remain accessible.
The card is capped at 58 columns with padded sections, status colors, and compact
token counts such as `12.4k` and `2.3M`. Input and output use separate colors;
cached input and recent usage remain visible beneath the totals.

Live usage is independent of workspace away counters. Watching a workspace does
not reset it. `conversation.list` and `session.snapshot` expose `role`, `parent`,
and `usage` on each conversation. Tokens mean input plus output; cached input is
a subset of input, not an extra charge. These are observed tokens, not prices or
subscription-quota percentages.

Hovering the corgi badge opens the usage overview: observed tokens, then the top
agents. In terminals at least 124 columns wide, the card grows to 122 columns and
adds a Limits pane on the right. Each account gets a rule across the card, and its
agents sit under it, level with the account's limits: one line per window (5h,
7d), shortest first, with an 11-cell spark from the window's start to its reset,
the percent used and the time until the reset. Bars use the launcher's colors
(amber from 80%, red at 100%) and share one baseline: time left in the window is a
dim floor, and a slot with no reading is a gray bar at the previous reading's
level, since usage only rises within a window, or the floor before the first
reading. Accounts sort fullest first and keep their section with no
agents running. Agents belong to their provider's signed-in account and the
activity summarizer to its inference provider's; agents started under another
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` are counted under that default account.
Narrower terminals, and accounts with no readings, keep the single-table card.

Accounting reads known session files incrementally or uses native notifications,
with one source per conversation. A newly discovered child's initial file is
read from the start only up to 2 MiB. Earlier token records count only if the
session started during the tracked parent runtime and explicitly identifies its
own history with `subagent_history_start_ordinal`. Inherited records are excluded.
Otherwise, the initial tail establishes a baseline and subsequent usage counts.
Missing boundaries, counter resets, source changes, and gaps are marked as partial
coverage (`≥`), rather than inventing totals. Unknown usage appears as a dash.

Meters and five minute buckets live only in memory and reset on daemon restart or
reload. There is no historical ledger, pricing database, or archived-session scan.
Child discovery is Codex-first; recursive Claude child discovery is not included.

## Context

An agent's sidebar row shows how full its context window is only when that
matters. Once the agent is 70% of the way to compaction, its name line ends with
the share of the window, such as `74%`, and the name clips to make room. The
figure is amber, and red from 85% of the way. While the agent compacts it dims;
afterwards the smaller context is below the threshold and the figure goes away.
Ended sessions never show one.

The hover card always shows it. Its subtitle names the provider and model, such
as `codex · GPT-6 Astra` or `claude · Opus 5.5`, with a meter on the right such as `context ━━━━━━━━━━━━──── 74%`, in the same colors
(grey below 70% of the way) and with a `┼` tick at a learned compaction point.
Until the agent has a timeline, its activity takes the line below the subtitle,
so the meter never shortens it. Narrow cards shorten the bar and, below about 44
columns, show only `context 74%`.

While an agent compacts, the corgi on its activity line herds the letters of
“Compacting” into the word, sits, and curls up into the ellipsis after it,
where it stays. Beside it, a pile of dots fills up and squashes flat. A row too
narrow for the corgi shows “Compacting…” from the start.

The figure is the number Claude's statusline and Codex's footer show, taken
from the latest model call in the transcript. For Claude that is the last
main-chain assistant message's input tokens plus cache reads and writes; for
Codex, the last `token_count` event's `last_token_usage.total_tokens` against its
`model_context_window`. Subagent and synthetic error records are skipped. Claude
transcripts do not name the window, so Corgi follows Claude Code's model
families: newer models are 1M, older ones 200k unless the model id ends in
`[1m]`. Environment overrides such as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` are not
seen. The level changes once per model call, so a large tool result counts from
the next response.

The way to compaction is measured against where the model last compacted on its
own. Claude marks those compactions in its transcript (`compact_boundary` with
`trigger: auto`), and Corgi keeps that size per model, in memory, for every
conversation on it. Until one is seen, and always for Codex, whose rollouts do
not say what started a compaction, the measure is the whole window. Codex already
reports an effective window, and compacted at 81–89% of it in observed sessions.

After a reload or restart each transcript's tail supplies the level again, so it
is not saved. `conversation.list` and `session.snapshot` expose it as `context`
on each conversation: `used`, `window`, `compacts_at` (0 until learned) and `at`.

## Model names

A model id is resolved once, where it arrives from a hook or a transcript, the
way Claude Code reads ids: Bedrock (`us.anthropic.claude-haiku-4-5-20251001-v1:0`,
inference-profile ARNs) and Vertex (`claude-opus-4-5@20251101`) spellings, dates
and `[1m]` reduce to the first-party id, whose family and version give the name
and Claude's window. Names follow the CLIs' own: `claude-opus-4-0` is "Opus 4",
`claude-sonnet-4-6[1m]` is "Sonnet 4.6 (1M context)", `gpt-6.1-sol` is "GPT-6.1
Sol" (Codex writes "GPT-6.1-Sol"), `codex-auto-review` is "Codex Auto Review".
Ids of any other shape, such as a custom provider's or an application
inference profile ARN, keep their id and have no name. Claude Code's aliases
keep their spelling and take its model picker's names, without a version,
since Claude Code chooses it: `opus` is "Opus", `sonnet[1m]` "Sonnet (1M
context)", `opusplan` "Opus Plan Mode". `conversation.list` and
`session.snapshot` send the first-party id as `model` and the name as
`model_name`; the summarizer's are `system_model` and `system_model_name`.
The launcher's configured models and saved commands' `--model` keep the model
as written in `model` and send the name as `model_name`.

## Tests and simulation

Zig tests exercise reducers with supplied timestamps, shared acknowledgement,
delayed selection observations, native routing and approval ownership, worker
rotation, and live/cold checkpoint restoration. They do not need real providers.

Bun runs the process-level harness. `tests/provider_sim.ts` contains reusable
terminal/native provider doubles and a Codex observer double. Its gates freeze a
specific response until released, allowing delayed and reordered observations.
These are controlled models of the exercised protocols, not complete emulators of
the vendor applications.

```sh
./scripts/zig build test
./scripts/zig build -Dviewer-test-driver=true
bun test tests/provider_sim.test.ts
bun test tests/conversations.test.ts
bun test tests/codex_titles.test.ts
bun test tests/subagents.test.ts
bun run tests/run.ts smoke smoke_input smoke_terminal
bun test tests/reloads.test.ts
bun test tests/viewers.test.ts
```

The process suites use disposable runtimes and require permission to bind local
Unix sockets. The simulator's own tests use local sockets and child processes.
