# Viewer wake/pull versus push experiment

Status: one predeclared node-0 ABBA and all six runtime preflight cases passed.
Results are in `viewer_exchange_findings.md`; production code is unchanged.
This is a component experiment, not a proposed protocol implementation.

## Mechanism and scope

Corgi sends a small `viewer.wake` on a dedicated socket
(`src/server.ts:180–186`). The viewer waits for a 2 ms pause, subject to its
8 ms pane-frame and 33 ms flood limits, then requests `viewer.sync`
(`src/viewer.ts:32–41`, `:318–320`, `:421–449`). The reply uses a second socket.
Thus a frame can involve a viewer wake callback, a settle timer, a daemon
request/readiness callback, and a viewer response callback. Skipping application
work after an unrelated event does not necessarily remove the runtime wake.

Herdr directly queues accepted retained patches. In the frozen Herdr checkout
`/home/t/dev/personal/herdr-cpu-benchmark/source`:

- `src/server/headless/retained_surface.rs:488–605` prepares and serializes
  patches, queues them, and commits the surface receipt only on successful send.
- `src/server/render_stream.rs:244–311` validates boot, projection and base
  revisions before preparing the next surface revision.
- `src/server/client_transport.rs:270–336` has one pending render slot; full
  means defer and recover, rather than build an unbounded patch backlog.
- `src/client/mod.rs:1559–1600` applies an incoming patch and presents it
  directly. There is no separate request for that patch.

The fixture intentionally retains JSON and full View bodies to isolate the
exchange. It does not combine push with Herdr's row/cell patch encoding. Both
modes use production `peer.Client`, its bounded output queue and `ReadyLoop`
on the server; both use Node sockets, UTF-8 stream decoding and Corgi's bigint
JSON parser on the client. The client line-framing code is a local copy of the
RPC algorithm with push dispatch added, not the unmodified `rpc.Connection`.
Each mode keeps the same two sockets and two endpoint processes alive. A third
idle coordinator owns the benchmark lock and deadline. Its CPU is excluded.

The producer offers one canonical View every 50 ms. Pull sends the wake,
settles, requests and receives that View. Push sends the same View immediately.
This immediate-push variant is optimistic: production still needs the existing
2 ms settle / 8 ms minimum / 33 ms flood policy. Moving the settle timer to the
daemon adds timer work there; retaining it on the viewer leaves another viewer
wake. At 20 Hz the source has trivially settled between packets, so this fixture
cannot establish flood correctness or the full savings of a paced push design.
Both normalize surface stamps and compare the same canonical rows with their
previous rows. Capture, native surface installation, rendering, UI policy,
controls, images and agent observations are outside this experiment. Therefore
the result estimates exchange costs under these conditions; it is not a
rigorous whole-app savings bound. In particular, changing delivery timing can
change batching and rendering frequency in the real application.

## Controls and validation

`viewer_exchange_costs.ts` accepts saved View arrays/corpora. Its optional
fixture generator uses real `Terminal.surface` output at 132×47 for 32 successive
single-row updates, with plain and Unicode/style/OSC8 variants. It constructs
the surrounding hot View envelope with unchanged session/resources omitted.
That is representative canonical surface data, not a captured whole session.
The manifest records fixture, source, loaded native libraries, Bun revision,
CPU affinity and memory-node affinity.

Each timed trial uses a fresh endpoint pair, warmup, and a common absolute
measurement interval. Pull/push/push/pull balances order. Both modes include
the same optional 16 ms no-op heartbeat; `--heartbeat 0` separately explores
an otherwise idle client. This heartbeat is a scheduling sensitivity control,
not an implementation of Corgi's entire event loop. `--phase` moves producer
ticks within their 50 ms slots. Timer lateness is reported. No syscall profiler
runs during timing.

Before timing, verification covers byte-fragmented/coalesced UTF-8 JSON,
bigint counters, ordered revisions at 20 Hz, paused-reader backpressure and
disconnect rejection of an outstanding request. Under the burst/backpressure
scenario, pull may coalesce intermediate revisions while push preserves its
queued FIFO; both must reach the final state. Those burst cases are correctness
checks, not a fair throughput comparison. A stalled/failed trial is journaled,
and the coordinator kills the entire endpoint process group on its deadline.

Reported measurements include endpoint user/system CPU, all helper-thread CPU
within each process, voluntary/involuntary context switches, data/wake/settle
callback counts, requests, bytes, delivered revisions and row comparisons.
Latency uses `Date.now()` with 1 ms resolution. Neither callback counts nor
coarse context-switch counts are exact event-loop wake counts. An apparent CPU
difference must be reproduced with quiet SMT siblings and matched NUMA policy.

Planned first slot (format/typecheck and preflight only): generate both corpora,
then run `--verify-only` on each. This should take roughly 10–15 seconds plus
tool validation. A timed ABBA with default 3 s warmup + 10 s sample takes about
55 seconds per corpus/phase/heartbeat combination. Start with one combination;
expand only if there is a meaningful effect. Root coordinates the CPU slot.

```sh
numactl --physcpubind=8-15 --membind=0 bun tools/benchmarks/viewer_exchange_costs.ts \
  --make-fixture dist/viewer-exchange-plain.json --kind plain
numactl --physcpubind=8-15 --membind=0 bun tools/benchmarks/viewer_exchange_costs.ts \
  --fixture dist/viewer-exchange-plain.json --verify-only --out dist/viewer-exchange-preflight
numactl --physcpubind=8-15 --membind=0 bun tools/benchmarks/viewer_exchange_costs.ts \
  --fixture dist/viewer-exchange-plain.json --out dist/viewer-exchange-node0 \
  --warmup 3 --seconds 10 --heartbeat 16 --phase 0
```

## Production integration hazards if the experiment warrants it

A push subscription must have an explicit interest generation. Pane identity,
geometry, selected viewport, resources, selection and other policy still belong
in Bun. An old queued generation cannot overwrite the viewer after a focus,
resize or scroll change. A missing base revision must request a full resync.
Initial subscription needs an atomic snapshot/registration ordering so an
update cannot fall between them.

Backpressure requires a bounded policy: never drop an intermediate row delta
and apply its dependent successor. Full Views can be superseded only when
ordered controls, clipboard operations, bells and acknowledgements remain
correct. Receipt advancement belongs after acceptance by the output queue;
disconnect and rejected writes must leave resync possible. Slow rendering also
needs an explicit retained-latest contract so push does not force more frame
work than the present pacing policy.

Daemon handoff currently preserves socket descriptors, pending request input
and queued response bytes. Subscription generation, last accepted base and any
pending push need equally explicit ownership across handoff. Old viewers and
mixed-version replacement daemons require capability negotiation and the
current pull fallback. The small transport fixture proves none of these
production policies, and no adoption is implied by a component win.

## Push versus long polling: source-only production assessment

The existing watch socket is a natural separate push channel; the ordinary
RPC socket must remain available for commands, images and input. Socket callbacks
should parse and retain incoming values, then wake the viewer loop. Applying a
View can await actions (`src/viewer.ts:154–176`), so doing that directly inside
the callback would introduce reentrant UI mutation. UI composition, host pacing,
overlays and installed receipts remain viewer policy in Bun.

A current `View` is not necessarily a self-contained full snapshot. It may omit
unchanged surfaces, session and resources (`src/viewer_protocol.ts:145–192`).
Replacing an unsent View with the next such View can therefore lose changes.
A small safe queue would keep the currently partially written JSON frame intact
and a dirty indication for the next view, then build that next view against the
last accepted wire receipt once output has room. Alternatively, pending values
must be merged by pane/identity plus session/resources and ordered controls.
Repeatedly capturing and replacing complete objects while the socket is blocked
would waste the work this change aims to remove. `peer.Client` currently has one
concatenated byte queue, not a separate replaceable render slot.

Mouse selection deliberately ignores incoming surfaces and does not advance
`Mirror.known` (`src/mirror.ts:187–235`). Transport delivery is therefore not
installation or presentation. On release, a subscription update must include
the still-installed receipt and force catch-up even if the daemon previously
sent a newer surface. Input modes, scrollback offset, images and identity changes
must be handled in that same generation. Attention/read acknowledgements must
stay in `presented()`, after host output, as they are now.

Passive output could use one daemon-side due timer per viewer with the same
first/last-output times and last-send time. The viewer's immediate-echo and idle
prompt exceptions are harder: `typed` and `active_at` are viewer-local
(`src/viewer.ts:309–320`, `:432–438`, `:500–502`). The daemon cannot infer the
exact policy from a PTY feed alone. A production design needs explicit prompt
hints/transitions, while retaining synchronous interest updates and ordinary
sync after input/focus/resize. It must also avoid reusing an old generation when
an asynchronous resize or workspace save finishes. Moving timer policy into
the Bun daemon is possible; silently dropping these exceptions is not equivalent.

Long polling is a smaller framing change but does less work elimination. A
dedicated request waits until the next due change (or quiet deadline), returns
one View, and the client immediately issues the next request. It removes the
small wake message and the request round-trip from the critical response path,
but still costs one client request and daemon read callback per frame. It must
use a separate connection: `peer.Client` serializes requests behind `busy`
(`src/peer.ts:177–185`), so holding a long poll on the command connection would
block input. A deferred request should remain represented in saved input until
its response is queued; current handoff saves pending input and remaining output
bytes (`src/persist/handoff.ts:41–68`), not arbitrary outstanding Promise state.
Generation replacement/cancellation is still needed when interests change.

Recommendation pending the component result: direct push has the larger wake
reduction potential, but it requires explicit pacing and delivery receipts.
Long polling is useful only if removing the wake leg alone is measurable; it
does not remove the recurring request/read cycle. Neither warrants protocol
work for a tiny isolated result. If immediate push is material, add a separate
daemon-paced push fixture before considering production changes.

## Prepared paced follow-up

After the short comparison, an opt-in `--paced-push` source variant was added.
It changes the candidate from immediate push to a daemon timer using the same
`max(min(lastChange + 2, firstChange + 33), lastSent + 8)` rule. Server settle
callbacks are counted separately; the producer, client heartbeat and JSON/
receipt work remain the same. The default still selects immediate push. This
new variant has not yet been formatted, checked or run.

The next proposed timing is `--paced-push --warmup 120 --seconds 30
--heartbeat 16 --phase 0`, retaining pull/paced/paced/pull order. That is about
ten minutes of endpoint runtime, intentionally warming like the whole-app
experiments rather than treating the short three-second warmup as a steady-state
ranking. Root must grant that slot. Validate the paced runtime preflight first.
The producer's common timer registry now removes completed handles so the long
warmup does not accumulate dead timer objects; both arms use that same registry.
The initial exact harness remains archived under the short run's `timed/sources`.

At 20 Hz the minimum and flood bounds are not stressed. This fixture still does
not prove the production typing/idle exceptions, changing interests, render
backpressure or handoff. Its result would only quantify the passive settled
exchange with timer work retained on the daemon.
