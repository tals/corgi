# Public Bun streams as a PTY read owner

Source audit of Bun `38afee6c84fcf48c0edb2466aa4b27d287a59c30`, checked out
at `/home/t/dev/vendor/bun-corgi-boundaries-20261026`. This matches the installed
Bun 1.4.4 revision. No runtime or performance result is implied by this audit.

`Bun.file(fd).stream()` has a plausible native event-loop path for Corgi's
nonblocking PTY masters. `fs.createReadStream({fd})` takes a different path and
is not an equivalent readiness replacement. The unresolved requirement is
lossless quiescence for handoff, together with bounded read fairness.

## Descriptor and polling path

- `src/runtime/webcore/FileReader.rs:123–236`: a non-stdio numeric descriptor is
  duplicated on stream start, its flags and type are inspected, and a
  nonblocking character descriptor is classified as `NonblockingPipe`.
  Corgi already makes the master nonblocking in `native/posix.zig:41` and
  `src/fd_loop.ts:48`. A generic blocking character descriptor does not get
  the same guarantee; the special TTY reopen path applies to stdio.
- `FileReader.rs:302–408` adopts the duplicate and starts the reader using the
  current Bun event loop. The original descriptor must remain valid until
  the lazy stream has started. A duplicate shares the kernel open-file
  description and PTY byte queue; it is not an independent reader position.
- `src/io/PipeReader.rs:516–589` registers `BufferedReader` with Bun's
  `FilePoll`. `src/io/posix_event_loop.rs:605–683` uses epoll one-shot read
  readiness on Linux and kqueue dispatch on macOS. This read path does not
  require Corgi's readiness pthread and notification socket.
- `PipeReader.rs:679–739` uses `read`, not socket `recv`, for a PTY. On Linux
  it initially attempts `preadv2(RWF_NOWAIT)`, caches unsupported status, and
  otherwise uses zero-time `poll` followed by `read`. `EINTR` is retried;
  `EAGAIN` rearms readiness. This still has polling syscalls and is not a
  promise of fewer syscalls than Corgi's direct nonblocking `read`.
- Zero-length read is EOF. Other read errors, including Linux PTY hangup
  `EIO`, reach the stream as errors (`PipeReader.rs:710–739`,
  `FileReader.rs:953–997`). Corgi deliberately treats `EIO` as hangup in
  `src/pane/terminal.ts:208`; any stream adapter must preserve that behavior
  while delivering preceding bytes.
- Cancellation closes the duplicate, not the original
  (`FileReader.rs:607–624`, `PipeReader.rs:322–351,431–455`).

## Public adapters, allocations, and backpressure

`Readable.fromWeb(Bun.file(fd).stream(), options)` detects the native stream
and uses Bun's native-readable adapter (`src/js/internal/webstreams_adapters.ts:36–41,576–615`).
It is not the generic `reader.read().then(...)` wrapper for arbitrary Web
streams. `src/js/internal/streams/native-readable.ts` shows the costs:

- A reusable JS `Buffer` is allocated in `getRemainingChunk` (128–137), using
  the Node `_read(n)` request when supplied. The adapter initially defaults
  its own budget to 256 KiB (92–93), but this FileReader returns Ready, which
  the source binding converts to 16 KiB (`ReadableStream.rs:1387–1404`);
  the adapter then clamps its internal budget (153–160). The Node readable
  watermark and FileReader's separate, fixed 16 KiB read-ahead watermark are
  therefore distinct. Passing a `.stream(chunkSize)` argument is not shown
  setting the FileReader watermark in `ReadableStream.rs:533–568`.
- A synchronous native `pull` can read directly into this buffer. A pending
  pull allocates a promise and installs fulfillment/rejection callbacks
  (173–193). A partial successful read produces two Buffer subarray views
  (232–245). It is not an allocation-free callback path.
- Event-driven reads commonly use a lazily allocated, shared 256 KiB scratch
  buffer (`src/io/pipe_read_scratch.rs:4–41`), then copy into the pending JS
  buffer (`FileReader.rs:727–785`). Owned native chunks can sometimes be
  transferred instead. Native read-ahead without a JS pull is separately
  buffered (653–692); nested reads can use a per-reader buffer instead of
  the shared scratch.
- `push()` returning false calls native `setFlowing(false)` (224–229), which
  unregisters native readiness (`FileReader.rs:1024–1052`,
  `PipeReader.rs:354–367`). Public Node `pause()` only changes Node delivery
  flags (`src/js/internal/streams/readable.ts:1184–1200`); it does not itself
  make that native call.
- Corgi bounds each readiness callback to eight reads of a reusable 64 KiB
  buffer (`src/pane/terminal.ts:198–219`). Bun's read loop uses backpressure
  and shared-scratch chunking instead (`PipeReader.rs:742–919`). A JS adapter
  can bound delivered work per turn, but that does not prove the same bound
  on native read-ahead or native callback work.

`fs.createReadStream({fd, autoClose:false})` is a poor substitute here:
`src/js/internal/fs/streams.ts:279–319` allocates a buffer for each `fs.read`,
copies short reads into a second buffer, and treats a read error as an error
without an `EAGAIN` readiness retry. Its asynchronous filesystem operation
runs on the worker pool (`src/runtime/node/node_fs.rs:1045`), so a blocking
PTY can hold a worker. `_destroy` waits for pending filesystem IO and then
closes the supplied descriptor (326–384), including when explicit destruction
is requested with `autoClose:false`. It does not duplicate that descriptor.

## Handoff boundary

Corgi's `Terminal.pause()` synchronously unregisters readiness without reading
or closing the PTY (`src/pane/terminal.ts:412–425`). `server.pause()` invokes it
for every pane; handoff captures the manifest before its first await
(`src/persist/handoff.ts:164–177`). Therefore all consumed output is already in
the native terminal, and all unconsumed output remains in the kernel queue.

A public stream introduces two additional locations: native read-ahead and
the Web/Node stream's queued or pending JS chunks. Preserving the original
descriptor alone is insufficient. Standard Web cancellation discards queued
data. On the Node path, `destroy()` cancels the native reader and may discard
read-ahead (`native-readable.ts:265–290`); pushes after destruction are rejected
(`readable.ts:433–435`). Native cancellation can also settle an outstanding
read with its final buffered bytes (`FileReader.rs:905–942`), which makes the
pending promise's publication order relevant.

The source suggests a **candidate**, not a proven contract:

1. Stop normal delivery and pause the Node readable.
2. Await a microtask barrier to publish an already-settled native pull.
3. Synchronously `read()` until null, feeding every returned byte.
4. Destroy the stream, then capture the checkpoint using the original FD.

Native PTY reads run on the JS thread, so after step 3 there is no concurrent
native reader thread consuming bytes while JS cancels it. However the exact
public read-ahead/pending semantics need adversarial testing. Draining can
also keep consuming a continuous writer, so this needs a bounded abort path
and changes handoff preparation from synchronous to asynchronous. A fixed
number of quiet event-loop turns is not an established general quiescence
contract. If this sequence cannot be proved, the minimum needed primitive is
a drain-aware native stop operation; public cancellation alone is insufficient.

Replacing PTY output reads also leaves input backpressure. Corgi currently
arms READ plus WRITE while native pending input is nonempty
(`src/pane/terminal.ts:186–197,251–270`). A stream experiment must retain a
WRITE-only watch or supply an independently correct writable adapter. Other
ReadyLoop users, including handoff transport, mean replacing reads alone does
not remove the process's readiness infrastructure in every state.

## Verification harness and initial results

`pty_stream_lifecycle.ts` and `pty_stream_helper.c` compare the current
ReadyLoop, a raw Web reader, and Node native-readable with synchronous versus
microtask-barrier quiescence. An independent native writer exercises real raw
PTYs. Each case compares bytes accepted by the slave with bytes delivered to
the consumer plus bytes remaining on the original master after cancellation.
Only the original master is drained after stop; the canceled candidate cannot
hide missing bytes by continuing delivery. A bounded retry accounts for tty
flip/line-discipline delivery after a successful slave write.

Cases cover idle cancellation, first-chunk cancellation, queued read-ahead,
complete delivery, slave hangup with and without trailing bytes, original FD
ownership, and simultaneous output reads with queued WRITE rearming. Each case
is journaled before later cases run. Byte copying, polling, and assertions in
this harness deliberately make it unsuitable as CPU evidence. A timed micro
must follow lifetime and fairness validation, using the same native producer
and exact delivered bytes for both owners.

Preparation when the exclusive CPU slot is granted:

```sh
cc -O2 -shared -fPIC -pthread tools/benchmarks/pty_stream_helper.c -lutil -o dist/pty-stream-helper.so
numactl --physcpubind=8-15 --membind=0 bun tools/benchmarks/pty_stream_lifecycle.ts dist/pty-stream-helper.so
```

Initial lifecycle preflight on 2026-10-26 used the frozen V14 native libraries,
the installed matching Bun, CPUs 8–15 and NUMA node 0, and the global CPU lock.
The helper was built with pinned `./scripts/zig cc -O2 -shared -fPIC -pthread`.
Formatting and a focused strict TypeScript check passed. These are correctness
results, not measurements of speed:

| Read owner | Exact cases | Result |
| --- | ---: | --- |
| Current ReadyLoop | 29 / 29 | No missing bytes; original master remains open |
| Raw Web reader | 17 / 29 | Every first-chunk cancellation loses 4,095–24,576 bytes |
| Node native-readable, synchronous drain/cancel | 29 / 29 | Byte order, queued WRITE, hangup tails and FD ownership pass |
| Node native-readable, microtask barrier then drain/cancel | 29 / 29 | Same checks pass |

Both stream paths report `EIO` on Linux slave hangup. The raw Web reader's
`cancel()` also rejects with the already-recorded EIO after the stream errors;
attempt 1 stopped on that expected error, and its earlier results are retained.
Attempt 2 normalizes only this expected hangup error and completes all 116
cases. The raw Web delivery loop also exceeded a 512 KiB turn in one fixture;
waiting after a whole chunk does not itself impose a strict byte budget.

The Node results justify further investigation, not production adoption.
The existing fixture uses finite 2 MiB output and does not establish a bounded
quiescence time under a continuous writer. Nor does it force every possible
already-settled-but-unpublished promise ordering. No timing comparison was run.
The next proof must exercise those boundaries before changing Corgi's currently
synchronous pause contract.

Artifacts: `dist/pty-stream-lifecycle/attempt1.jsonl`, `attempt1.stderr`,
`attempt2.jsonl`, `summary.json`, `manifest.json`, and exact attempt source
copies. The manifest records helper and loaded native library hashes. Only the
original master was drained after cancellation, with bounded retries for tty
flip-buffer delivery; lost candidate bytes were not recovered through the
canceled reader.

## Next bounded proof and component measurement

No additional run is authorized by this section; the CPU slot is coordinated
with the parent agent. The next proof should add:

1. A continuous native writer, with the same byte-count accounting as the
   finite fixture. Run ordinary delivery with a strict 512 KiB per-turn budget
   and record event-loop heartbeat delay and progress of a second quiet PTY.
   Split a large Web chunk before delivery if that variant is retained for
   diagnostic comparison; splitting does not bound native read-ahead.
2. A bounded `tryStop`: pause delivery, drain at most 512 KiB and a short
   monotonic time budget, and destroy only if it reaches a trustworthy empty
   boundary. On budget exhaustion, restore the same reader and its callbacks,
   process every byte already returned, and explicitly report abort/rollback.
   Verify resumed bytes against the producer stream. This is an experiment
   interface, not a compatible replacement for production handoff: the
   current `Terminal.pause()` cannot fail just because output is continuous.
3. Cancellation with an outstanding, not-yet-settled pull on an empty PTY;
   subsequent writer bytes must all remain on the original descriptor.
4. A separately labeled publication-order stress. In the pinned source,
   `streams.rs:705` enters a microtask scope when fulfilling a native pull,
   but `jsc/event_loop.rs:384–400` suppresses the checkpoint for nested or
   deferred dispatch. A benchmark-only wrapper around the native pull's
   registered promise continuation can defer Node publication by exactly one
   microtask and invoke cancellation before that publication. Compare sync
   stop and the barrier sequence, preserving all results. This is a deliberate
   scheduling injection, not evidence that this ordering occurs in ordinary
   Corgi. Do not use private native handles to make the adapter pass.

If no public sequence gives lossless bounded synchronous quiescence, the
experiment should state that limitation and stop short of production use.
Changing handoff to retry or fail under flood is a product-semantic change,
not merely an implementation detail.

Only after a viable lifecycle decision, the timed component should compare
actual ReadyLoop → bounded read → `Terminal.feed` with the accepted Node
native-readable → bounded delivery → the same `Terminal.feed`. Use 16 real
raw PTYs at 20 Hz, aligned and staggered schedules, frozen V14 native libraries,
one visible 20 Hz surface capture, every-pane 4 Hz live-text observations and
50 ms maintenance. Keep a separate queued-WRITE correctness case; adding an
always-idle WRITE watcher to timing would obscure whether read ownership
actually removes the readiness thread in the ordinary case.

Record process and per-thread user/system CPU, byte/feed counts, callback
counts, producer CPU and visible delivery latency. Frozen native feed/capture
work must be identical; differences in chunking/revision increments need
semantic prefix comparisons rather than raw stamp equality. Reuse one native
producer for both modes, archive sources and DSO hashes, run serialized ABBA
with the established NUMA/L3 affinity and sibling observer, and state whether
any reported CPU excludes the producer. A successful stream timing would
measure avoided notification transport, not the native-actor experiment's
separate move of VT feed off Bun's main thread.

## Extended proof results

The extended fixture ran under the same pinned Bun, frozen V14 native library,
CPU/NUMA affinity and exclusive lock. Pinned Zig helper compilation, focused
strict typechecking and formatting passed. `--extended` completed 76 cases:

| Case | Synchronous Node stop | Node stop with microtask barrier |
| --- | --- | --- |
| Empty outstanding pull; write after cancellation | Exact | Exact |
| PTY write followed by another Bun socket triggering stop | 32 / 32 exact | 32 / 32 exact |
| Artificial one-microtask publication gate | Lost 135,231 bytes | Exact |
| Continuous writer; bounded stop and rollback | 4 / 4 exact | 4 / 4 exact; one actual budget exhaustion |

The publication gate temporarily wraps only the initial empty-PTY pull's
promise continuation, restores `Promise.prototype.then` immediately, then
delays Node's publication by one microtask while invoking stop. It is deliberate
contract stress, **not observed natural byte loss** or evidence that Bun usually
orders those callbacks this way. The socket-triggered trials do not control
the kernel/event-loop dispatch order and cannot establish every possible order.

Each flood trial first forces a zero-budget abort to verify that the same reader
resumes without losing bytes, then tries the real 512 KiB / 2 ms stop budget.
All eight forced rollbacks resumed delivery (over 1 MiB per trial). One barrier
trial also exhausted the real budget, rolled back, resumed, and finished with
exact accepted/delivered/remaining byte accounting. The largest ordinary
delivery pass was 352,255 bytes, below 512 KiB. Timer heartbeats continued. This
is a bound on the adapter's delivered work, not on Bun's internal read-ahead;
the fixture does not yet measure competing-pane service latency.

The necessary interpretation is limited: the async sequence survived these
byte-preservation cases, but bounded stop may fail under ongoing output.
Rollback preserves data; it does not preserve Corgi's unconditional synchronous
handoff behavior. The implementation remains benchmark-only, and no stream
performance timing or production change followed this proof.

Artifacts are in `dist/pty-stream-extended/`: per-case `attempt1.jsonl`,
`summary.json`, exact attempted sources, helper DSO, build/type/format logs and
`manifest.json` with source/helper/loaded-library hashes. Initial finite-output
results remain independently frozen in `dist/pty-stream-lifecycle/`.
