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

`providers.Backend` dispatches to concrete `Claude` and `Codex` integrations. These
compose shared codecs and own hook/native envelope decoding, launch arguments,
and typed resume arguments. Transport ownership stays in `native.Session` or the
terminal pane. Screen detection and the read-only Codex observer remain separate
sources; a future provider can reuse the sources it actually supports.

## Observations and switching

- Hooks select on `SessionStart`. Later events for a conversation known to that
  attachment update that actor without changing selection. A first hook can also
  establish identity on a fresh attachment before process detection identifies
  the provider. After process replacement, this requires fresh provider detection
  or a `SessionStart` hook.
- Codex title resolution carries the pane's process ID, title revision, and
  attachment generation. Results from before a switch are rejected, including
  A→B→A. Repeating or decorating the same conversation title leaves its revision
  unchanged. Identified active conversations can continue being polled after selection
  changes. Idle detached conversations are retained but not continuously polled.
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

The optional parent field leaves room for individually addressable subagents, but
this migration does not discover child actors or add a transcript browser.

## Tests and simulation

Zig tests exercise reducers with supplied timestamps, shared acknowledgement,
delayed selection observations, native routing and approval ownership, worker
rotation, and live/cold checkpoint restoration. They do not need real providers.

Python remains the process-level harness. `tests/provider_sim.py` contains reusable
terminal/native provider doubles and a Codex observer double. Its gates freeze a
specific response until released, allowing delayed and reordered observations.
These are controlled models of the exercised protocols, not complete emulators of
the vendor applications.

```sh
./scripts/zig build test
./scripts/zig build -Dviewer-test-driver=true
python3 tests/provider_sim_test.py
python3 tests/conversations.py
python3 tests/codex_titles.py
python3 tests/smoke.py
python3 tests/reloads.py
python3 tests/viewers.py
```

The process suites use disposable runtimes and require permission to bind local
Unix sockets. The simulator's own tests use socketpairs and child processes.
