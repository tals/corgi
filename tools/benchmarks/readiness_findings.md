# PTY readiness and read ownership

Source investigation, 2026-10-26. This note does not claim a measured batching
speedup. The v8 diagnostic reported about 319 terminal feeds/s and 638 TS drain
invocations/s with sixteen agents producing twenty updates/s each. The native
readiness thread used roughly 0.7–0.96% of a core in recent runs.

## Three read paths, one output stream

The baseline has three places attempting to consume the same PTY:

1. `Terminal.attachReadiness` calls the TS `drain` when a notification arrives.
   It reads up to eight 64 KiB chunks, feeds Ghostty, flushes input, and rearms.
2. The daemon sees the resulting `dirty` state and calls `Terminal.read` during
   collection. That calls TS `drain` again, usually finding EAGAIN.
3. `Terminal.read` calls native `terminal_tick`, whose Zig `Terminal.read` also
   tries to read up to eight 16 KiB chunks before performing maintenance.

Thus the two measured TS drains per feed do **not** establish duplicate kernel
notifications or two program writes per update. They are explained directly by
two callers. The third native read is nested in `native.tick`, not `pty.drain`.
Readiness and later collection also each rearm the one-shot kernel registration;
the native thread's notification batching cannot remove those `epoll_ctl` calls.

The v10 source change gives normal PTY reads to the readiness callback. A new
native `maintain` operation only fills a deferred launch command when the line
editor is ready and expires synchronized output. Daemon collection calls the TS
maintenance method. Public/manual `read` still drains first, preserving fresh
reads for close/reap and explicit callers. The legacy native tick remains as a
reference. Existing bounded-drain fairness, write flushing/rearming, EOF,
pause/resume, and descriptor handoff stay in their existing owners. The native
ReleaseFast build passed 52 tests (36 pane, 16 compositor); focused TS terminal
tests passed 19 tests with 202 assertions, including real PTY prefill/deadline
checks, queued-output ownership, manual freshness, readiness pause/resume and
descriptor handoff, clipboard, backpressure/order, and child exit. Logs:
[native build](../../dist/native-single-reader-build.log) and
[focused terminal tests](../../dist/native-single-reader-focused-tests.log).
Native library SHA-256:
`7f5aa70a5eb6bdd743c6edcd7cce25af41073ade0fb56116dcb29916dad36c1c`.
Performance results for this change are pending.

## What notification batching can save

`native/readiness.c` waits for up to 64 epoll/kqueue events but sends each
eight-byte `{token, events}` record with a separate `send`. A small mechanical
alternative packs the same ordered records into a 512-byte stack array and
sends that batch with the existing partial-write/EINTR loop. It introduces no
delay, new queue, heap allocation, token deduplication, or readiness policy.

If the kernel returns `E` notification records in `B` nonempty wait results,
the ordinary successful-send count changes from `E` to `B`. That is useful only
when the measured batches contain multiple records. Independent staggered
writers can produce mostly singleton batches. Shutdown must still interrupt a
blocked sender; the current blocking notification socket is released with
`shutdown` before joining its thread. macOS can return read and write records
for the same token separately, so preserve record order instead of assuming
each returned token is unique.

There is no evidence yet that one `send` equals one Bun event-loop wake. The
notification socket is a byte stream, and a single receive can already combine
several small sends. At 319 records/s its payload is only about 2.5 KiB/s; syscall,
scheduling, callback and object overhead matter more than copying those bytes.

## Bun's side of this boundary

Inspected the installed runtime's matching source, Bun 1.4.4 commit
`38afee6c84fcf48c0edb2466aa4b27d287a59c30`, in the read-only clone at
`/home/t/dev/vendor/bun-corgi-boundaries-20261026`.

`src/js/node/net.ts` passes the imported descriptor through `Bun.connect`.
`src/runtime/socket/socket_body.rs:704` gives it directly to uSockets;
`packages/bun-usockets/src/socket.c:456` adopts it into Bun's main event-loop
poller and sets nonblocking mode. There is no per-notification FD duplication.
The receive path in `packages/bun-usockets/src/loop.c:741` reads into a shared
native receive buffer. `socket_body.rs:2355` converts that data to the requested
JS binary type; `src/jsc/array_buffer.rs:1003` explicitly clones the bytes.
`net.ts:827` pushes the Buffer into the Node-compatible stream, which dispatches
to Corgi's `ReadyLoop` data handler.

Corgi parses complete eight-byte records from that Buffer and looks up each
callback. It copies only when a previous receive ended with a partial record;
ordinary `subarray` operations make views. Replacing Node-compatible stream
handling with `Bun.connect` could remove an adapter layer, but it would retain
the native-buffer-to-JS copy and the custom readiness thread. That is a separate,
unmeasured change. Adopting a PTY directly through the socket path is not an
equivalent replacement: the inspected uSockets path uses `recv`, while PTY data
is read through `read`.

## Counters before another optimization

A small opt-in diagnostic should collect cumulative counters without clocks or
hot-path logging:

- Native wait-result histogram for sizes 1–64; notification counts by readiness
  bits; send calls, short writes and EINTR; arm/mod/add/delete counts.
- JS notification-socket data callbacks, bytes and records per callback,
  partial-record carries, and records whose token no longer has a callback.
- PTY read calls, positive reads/bytes, EAGAIN, EOF/EIO and slice-limit exits,
  separated by readiness and explicit/manual drains.

Use relaxed atomic counters for values shared between the native reporter and
JS; reading ordinary C integers concurrently would be a data race. Keep counts
cumulative and take phase deltas instead of racing resets. Native code can
aggregate per batch before publishing counters. Snapshot creation and export
belong outside timed windows. A zero-byte readiness callback can mean an older
queued one-shot notification after a manual drain or a write-ready event; it
is not by itself proof of duplicate notification delivery.

Only after those distributions are available should a batch implementation be
compared against the frozen baseline. Keep idempotent rearm tracking separate:
an event can already be queued while JS still believes its registration is
armed, and macOS read/write one-shot filters have independent lifetimes.

## V11 shared descriptor arming state

The v11 source change suppresses an identical arm only when the same
registration still owns the descriptor's last successful interest mask. A
known mask means its kernel subscription is active **or** a notification is
already pending that will clear the cached state before dispatch. Every
matching-token notification invalidates that descriptor's state before calling
the application; a callback that rearms therefore performs a real native call.
Changed interests, native-call failures, and close also invalidate the state.
Close always issues the native removal, including for a cached zero mask.

This state must be shared per descriptor, not merely cached per watch. Herdr
handoff's `SocketIO` retains one registration while `accept` temporarily creates
another on the same request descriptor (`src/import/herdr.ts:369,809`). Closing
the temporary watch removes the kernel entry; the original watch must not then
skip a needed arm because its own old mask is unchanged.

`ReadyLoop` stores a stable state object per watch in a map keyed by descriptor.
Arm can skip only if the mapped object is that watch's object and the mask
matches. A dispatched older event invalidates even a newer mapped owner on the
same descriptor, causing at most an extra rearm. On macOS, a separately queued
old write-filter event is handled the same way. Closed tokens are removed from
the callback map and never reused within the loop, so they cannot invalidate or
invoke a replacement watch. No per-arm object allocation or per-notification
map deletion/reinsertion is introduced. Native notification batching is unchanged.

Eight new source tests cover unchanged masks, duplicate watches and closing
either owner, queued old read/write notifications, stale sibling notifications,
failed calls and zero masks, closed/replaced tokens, and real socket one-shot
read/write delivery across pause/resume. All eight pass in the v11 focused run:
46 TS tests, 721 assertions, covering readiness, title ownership, terminal
maintenance, live text, and snapshots. Native tests passed 52/52; formatting and
typechecking passed. See [focused tests](../../dist/retained-v11-focused-tests.log)
and [native build](../../dist/retained-v11-native-build.log). The native library
SHA-256 is `2c9bcb9e2f9a3ac249c9fd9dfb541c401ea6b60197ef45dfa4961fbbfb92456c`.
Whole-suite validation and performance measurements belong to the coordinated
parent run; these checks alone establish no speedup.


## V13b bounded batching component measurement

`dist/readiness-v13b-node0/summary.json` and `comparison.json` preserve the first
node0 block; `artifact-manifest.json` hashes its raw inputs and outputs. The
benchmark compiles the frozen original and exact candidate readiness C sources
with pinned Zig 0.16.0 `cc -O3`, as separate tiny libraries. It substitutes only
the `fd_loop_*` functions used by the actual frozen-v12 `ReadyLoop`; ordinary
socket helpers and JS dispatch/rearm code are identical. The borrowed function
bindings are restored after all watches, producer, loop and descriptors close.

One native producer supplies sixteen socketpairs at 20 updates/s each, with
128-byte sequence-tagged payloads. Aligned writers issue each group of sixteen
without an inserted delay; staggered writers use absolute deadlines 3.125ms
apart. This tests event transport, not PTY emulation or daemon collection.
Each scenario uses fresh-process ABBA trials, 3s warmup and a 10s CPU window,
with eight-core node0 affinity, node0 memory and per-task 1024/1024 utilization
clamps. Process CPU and the readiness/producer pthread clocks are measured
separately. Counters are compiled out of these timing libraries.

All eight timing trials passed exact per-lane generated bytes, 19–21Hz progress,
loaded-library provenance, thread clamps and whole/timed-window SMT <2%.
The table gives means and ranges across the two accepted trials per version.
Percentages are percent of one core; these are component results, not a
prediction of whole-Corgi savings.

| Scenario / CPU scope | Original | Batched |
| --- | ---: | ---: |
| Aligned readiness thread | 0.1098% (0.1048–0.1148) | 0.0598% (0.0587–0.0609) |
| Aligned process minus producer | 0.7674% (0.7258–0.8091) | 0.6702% (0.6562–0.6841) |
| Staggered readiness thread | 0.6887% (0.6792–0.6981) | 0.6877% (0.6846–0.6908) |
| Staggered process minus producer | 2.2670% (2.2440–2.2900) | 2.1599% (2.1586–2.1612) |

Aligned readiness-thread CPU falls 45.5%, saving 0.0500 percentage points. The
staggered readiness-thread result is flat (0.14% relative difference), so the
lower whole-consumer numbers there must not be attributed to send batching.
Producer CPU also varies: aligned 0.1079%→0.1105%, staggered 0.6300%→0.5769%.
The main Bun process includes runtime/helper work and finite-run variation.

Separate four-second diagnostic libraries intercept only the included C
source's `epoll_wait`, `send`, and `epoll_ctl`. Cumulative relaxed atomic counts
and a wait-size histogram explain the mechanism. A diagnostic-only reference
buffer verifies every sent token/event byte against the exact sequence returned
by that kernel wait, including partial-write offsets. It reports zero byte/order
mismatches in all runs. Timestamps are embedded in benchmark payloads only for
these diagnostics; diagnostic CPU is excluded from the timing comparison.

For aligned traffic, the measured 1280 records needed 1280 sends in the original
but 130 sends in the candidate. Kernel waits were 149 and 130 respectively, or
8.59 and9.85 records/wait; both performed 1280 epoll_ctl operations. Across the
full diagnostic including its short completion tail, Node data callbacks were
87 versus84 for 1344 records. Thus eliminating 1150 sends did not eliminate 1150
Bun callbacks: the stream receiver already coalesced records. There were no
short sends, EINTR, partial-record carries or ordering mismatches.

For staggered traffic, both diagnostic runs returned exactly one event per
wait: 1280 waits, records, sends and rearm calls. The original staggered diagnostic
was rejected for 18.76% whole-run / 16.32% measured-window sibling load; preserve its
counter observations, but do not compare its latency or CPU causally. No retry
was performed. The other three diagnostics passed the isolation guard.

Candidate diagnostic latency from producer write timestamp to JS payload drain
was aligned median 0.137ms/p95 0.282ms/p99 0.931ms/max 1.017ms; staggered median
0.053ms/p95 0.129ms/p99 0.338ms/max 0.810ms. Original aligned p99 was 0.502ms and
max 0.594ms. These short, instrumented tails are noisy and do not establish a
latency improvement; all remain below the 250ms progress guard. The implementation
adds no timer or batching delay, but a larger latency sample would be needed
for a precise tail-regression claim.

Keep the bounded mechanical batch for naturally multi-event waits. It has a
clear aligned syscall/thread-CPU mechanism, unchanged bytes/order/progress, and
no measured staggered readiness-thread penalty. It does not address singleton
wake scheduling or prove a significant application-level improvement. A direct
callback boundary is a separate experiment, not a reinterpretation of this run.



The separate [Bun boundary audit](bun_boundaries.md#source-audit-threadsafe-bun-jscallback-as-a-future-boundary) covers callback queue allocation, keepalive and shutdown requirements.

## Prepared callback transport experiment

`readiness_costs.py --direct-callback` accepts the same batched C source for both
roles. Its benchmark wrapper substitutes only the notification send: one role
keeps the current socket transport, and the other posts each ordered token/event
pair through a threadsafe Bun `JSCallback`. Both retain the native socketpair and
actual `ReadyLoop` Socket; the callback role leaves it idle as a lifetime anchor.
The callback dispatches through the existing token map and watch wrappers.
This is a benchmark implementation, not a production transport change.

A separate untimed preflight checks native-producer FIFO order, queued stale
tokens after descriptor re-registration, actual read/write interest changes,
a delayed foreign-thread callback with no JS timer pending, and fifty queued
callbacks across loop/callback shutdown. Shutdown clears the map and joins the
native reporter before closing the callback. Late invocations return before
touching freed native state. The timed aligned/staggered ABBA plan remains
3s warmup plus10s measurement per trial; diagnostics additionally compare the
entire received notification sequence with the kernel-wait sequence.

Diagnostic reports distinguish transport calls, physical sends, Node data
callbacks and FFI callbacks. The reported minimum queue-allocation count is
three times FFI callbacks, derived from pinned Bun/WebKit source; it is not an
allocator measurement. At320 records/s that path implies at least960 native
queue-object allocations/s. Counter-free process and reporter CPU determine
whether removing socket handling pays for those allocations and per-record
main-loop dispatch. The first executed block and its limits follow.

## Callback component result, 2026-10-26

`dist/readiness-callback-node0-retry1` contains the completed block, including
copied C/TS/Python sources, compiled libraries, preflight output, raw observers,
`comparison.json`, `summary.json` and `artifact-manifest.json`. The frozen v12
application dependencies and observer were copied separately from previous
experiments; both transports used identical current batched readiness C bytes.
The initial `dist/readiness-callback-node0` attempt is rejected and preserved:
a coordinator loop shadowed the trial label and overwrote observer log labels.
The running finite child finished before stopping that coordinator. The fresh
retry changes only that coordinator bookkeeping and adds copied harness inputs.

Tools typecheck passed. The runtime preflight passed FIFO delivery, queued stale
tokens after same-descriptor registration, actual read/write interest changes,
idle-Socket keepalive with no pending JS timer, and all fifty queued invocations
after loop/callback close. All twelve completed trials passed generated payload
bytes and progress; every diagnostic's full notification log exactly matched
the kernel-wait token/event sequence. This validates the benchmark's lifetime
arrangement; it does not remove the Socket or establish a production design.

The aligned ABBA block has two accepted timings per transport. The staggered
block has two accepted socket timings and only one accepted callback timing;
the other callback timing exceeded the unchanged 2% whole-run SMT guard
(2.129%, versus1.648% inside its timing window). All values below are percent of
one core, with the producer thread removed from consumer process CPU.

| Scenario / scope | Batched socket | Scalar callback |
| --- | ---: | ---: |
| Aligned consumer process | 0.734% (0.660–0.808) | 0.614% (0.597–0.631) |
| Aligned readiness thread | 0.0786% (0.0610–0.0962) | 0.0823% (0.0760–0.0886) |
| Staggered consumer process | 2.975% (2.758–3.192) | 2.576% (one accepted trial) |
| Staggered readiness thread | 0.873% (0.870–0.877) | 0.790% (one accepted trial) |

Aligned consumer CPU falls0.120 percentage points, or16.4%, while reporter CPU
overlaps. Producer CPU is0.132% versus0.110%; it is reported separately, not
credited as a transport saving. The staggered difference is directionally0.399
points (13.4%), but one accepted candidate is insufficient for a reliable effect
estimate. Its producer CPU is0.843%, versus a socket mean0.807%. These short runs
show a plausible modest component opportunity, not a whole-daemon improvement.

The full aligned diagnostics delivered1344 records: socket162 sends and84 Node
data callbacks, versus zero notification sends and1344 FFI invocations. The
staggered diagnostics delivered1344 records through1344 sends/Node callbacks,
versus1344 FFI invocations and no notification sends. Both modes kept exactly
one rearm per phase event and unchanged payloads. The FFI path therefore implies
at least4032 native queue-object allocations for those1344 calls, from the pinned
source audit. Eliminating Buffer/stream dispatch does not eliminate allocation.

Both callback diagnostics exceeded the SMT guard (aligned2.876% whole/3.812%
window; staggered1.762% whole/2.296% window). Their counters and exact-order checks
remain observations, but their CPU and latency are excluded from causal
comparison. All diagnostic maxima remained below1ms, including the rejected
runs; this is only a progress check, not a tail-latency improvement claim.

Keep this as an isolated prototype pending a repeated clean staggered block
and a real-application comparison if the component saving merits integration.
The idle Socket still owns resources, Bun still allocates queue objects per
record, and queued-callback shutdown requires explicit ownership. No production
callback change was made for this experiment.
