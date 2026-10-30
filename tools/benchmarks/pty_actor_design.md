# Native PTY reader fallback experiment

This is a source-only experiment design, not an implementation or a proposal
to adopt threading in production. Public-stream lifecycle validation comes
first. The purpose is to isolate moving PTY read/feed ownership, then separately
measure notification coalescing. No application policy moves into native code.

## Why this is a different mechanism

Current Corgi `native/readiness.c:26–68` polls on its readiness thread and sends
records through a socket. `src/fd_loop.ts:30–44` dispatches those records on Bun;
`src/pane/terminal.ts:186–219` then reads PTY bytes and calls `terminal_feed`
through FFI. The bytes travel kernel → reusable Bun Buffer → native VT.

The pinned Herdr implementation starts one actor thread per PTY
(`/home/t/dev/personal/herdr-cpu-benchmark/source/src/pty/actor/unix.rs:433–435`).
Its poll loop calls `read_once` directly (541–558), which reads 8 KiB and invokes
the terminal callback (823 onward). It does not make a Bun-like main-thread
round trip before parsing the output. That is the mechanism to test. The
proposed first Corgi prototype retains **one worker for all panes**, matching
Corgi's existing readiness-thread count; it does not copy Herdr's thread count.

## Small benchmark-only boundary

Use a separate C fixture DSO, dynamically loading the exact frozen Corgi term
DSO. Create and initialize all terminals on Bun before starting the worker.
The worker borrows their opaque pointers and the existing nonblocking master
FDs. It never closes or frees them. No production native signatures change.

The concrete proposed interface is:

```c
struct bench_pty_actor;
struct bench_pty_actor *actor_new(const char *term_library,
    void *const *terminals, const int *fds, unsigned count);
int actor_start(struct bench_pty_actor *);
void actor_lock(struct bench_pty_actor *, unsigned lane);
void actor_unlock(struct bench_pty_actor *, unsigned lane);
void actor_notify_mask(struct bench_pty_actor *, uint64_t lanes);
uint64_t actor_take_dirty(struct bench_pty_actor *);
void actor_kick(struct bench_pty_actor *); /* Pending input changed. */
void actor_pause_join(struct bench_pty_actor *);
void actor_stats(struct bench_pty_actor *, uint64_t *out);
void actor_free(struct bench_pty_actor *); /* Already joined. */
```

The fixture has one mutex per lane, one worker scratch buffer of 64 KiB, a
stop/control eventfd, and a poller. It services each ready lane with at most
eight `read` calls, matching Corgi's present 8 × 64 KiB maximum. It feeds every
positive read directly through the frozen DSO's `terminal_feed`, while holding
that lane's mutex. Zero/EIO marks hangup; EINTR retries; EAGAIN yields. Service
order and fairness counters are recorded. A later 8 KiB/single-read sensitivity
could separate read batching from ownership, but is not the first comparison.

Bun calls the existing surface, live-text, maintenance, input and metadata
methods within `actor_lock`/`actor_unlock` in `try/finally`. Initial testing
can lock around the complete existing synchronous method, including its Bun
decode, to avoid silently excluding boundary/lock costs. The lock is never
held across an await. A separate diagnostic pass measures lock wait and hold
time; normal timing does not clock every cell or byte.

## The lock must cover more than feed and capture

`native/bridge.zig:71–77` returns a borrowed title pointer. The lock must span
both `terminal_title` and the `toBuffer(...).toString()` copy in
`src/pane/terminal.ts:72–98`. Unlocking immediately after FFI creates a real
use-after-free race if the worker receives a new title. Scalar revision/PID
getters, input modes, clipboard state, pending input, rendering, selection,
resize, restore, and destruction also access mutable VT state and require the
same protection. The owned snapshot/live-text buffers can outlive the lock,
but creating those buffers must be protected.

Feeding is not read-only with respect to the PTY. `Terminal.reply` calls
`send`/`flush` (`native/zig/pane/terminal.zig:178–189,469–485`), and parser
callbacks mutate title and clipboard state. The worker must inspect pending
input under the same lock after feed and register WRITE interest when needed.
Bun's existing input `send` retains its order and 1 MiB backpressure bound;
after unlocking it kicks the worker if pending input requires WRITE service.
Protocol replies and user input use the existing shared queue under one lock.
No second unsynchronized writer or replacement reply queue is introduced.

Per-terminal locking does not prove every process-global dependency is safe.
`Terminal.create` assigns Ghostty's global PNG decoder callback
(`native/zig/pane/terminal.zig:83`), so benchmark initialization finishes before
worker start. Production creation during active workers would require a
one-time initialization treatment. `native/zig/os.zig:27` has shared Zig IO;
the pinned `Threaded.init_single_threaded` disables concurrency creation, not
all internal locking (`.tools/zig-x86_64-linux-0.16.0/lib/std/Io/Threaded.zig:1668–1691`).
Image/file IO and shared library state still need a dedicated audit before
production use. The first experiment uses text/style/link fixtures and makes
no claim that passing them validates all terminal features under concurrency.

## Synchronous handoff and cleanup

`actor_pause_join` sets stop, wakes the poller, and joins. The worker must finish
feeding bytes it already consumed before it exits, but must not start another
read once it observes stop. Bun must not hold any lane mutex while joining.
When join returns, all consumed bytes are in the VTs and all other bytes remain
in the PTYs; no borrowed pointer or private unread byte buffer survives. This
preserves the existing synchronous manifest boundary. Terminal capture then
runs without a competing worker. Rollback restarts the worker; successful
handoff transfers the original FDs, and later cleanup frees the stopped actor
before freeing terminals or descriptors.

The join latency is measured in lifecycle tests. A long single parser feed can
still delay pause, even with bounded read size. The prototype must not hide
that latency by returning before ownership has transferred.

## Three comparisons, with identical producer and Bun work

All modes use 16 real raw PTYs, 20 updates/s/pane, the same byte schedule and
132 × 47 VTs. Use aligned and staggered schedules. Bun performs one visible
surface capture at 20 Hz, live-text observations for every pane at 4 Hz, and
maintenance for every pane every 50 ms. Cursor, sync timeout, clipboard/title,
input and final surfaces remain testable. These are component measurements,
not substitutes for subsequent whole-app measurements.

1. **Current ownership:** the actual `ReadyLoop` dispatches to Bun's bounded
   read loop and existing `Terminal.feed`, followed by the same Bun jobs.
2. **Native read/feed, notifications retained:** the worker reads/feeds, then
   publishes every serviced readiness event to Bun. This isolates byte/feed
   ownership; notification counts remain visible and no coalescing benefit is
   attributed to read/feed alone.
3. **Native read/feed, hidden notifications coalesced:** Bun supplies a generic
   notify-interest mask identifying panes needing an immediate wake. Visible
   updates notify immediately; hidden dirty bits are collected at the existing
   50 ms maintenance cadence. Bun still runs each observer at 4 Hz and chooses
   all presentation/observation policy. Native code only maintains receipts
   and obeys the requested interest mask. This variant's additional benefit
   and maximum observation delay are reported separately.

A dirty-bit exchange plus a nonblocking notification channel must have an
explicit no-lost-wakeup protocol. Mark dirty before sending a wake; when Bun
consumes a wake it atomically takes the mask. An update racing that exchange
must either be included in the taken mask or generate a later wake. Capture
and observer receipts cannot share a single destructive dirty receipt; the
existing per-consumer revision checks remain authoritative.

## Evidence and acceptance checks

- Record total process CPU, Bun main-thread CPU, native worker CPU, producer
  CPU, and helper threads separately. Native CPU is moved work, not savings.
  Use thread CPU clocks or `/proc` endpoints; subtract producer only in an
  explicitly labeled consumer total. Report user/system split, wake/dispatch
  counts, reads, bytes, EAGAINs, feed calls, and notification counts.
- At each capture, obtain that lane's fed-byte offset under the same lock.
  Compare the captured surface to an independent reference replay of exactly
  that prefix. Different read chunk boundaries legitimately produce different
  `surface_revision` counts, so compare semantic cells/cursor/modes, title,
  clipboard and input replies, not raw instance/revision IDs. Do not compare
  two concurrent captures merely because their wall-clock timestamps match.
- Final accepted producer bytes, consumed bytes, remaining kernel bytes and
  terminal content must agree. Include fragmented UTF-8, CSI/OSC split across
  reads, wide/combining text, links, scrollback, sync-output expiry, title/OSC52,
  queued input, and terminal-generated replies. Validate input order against
  the actual serialized operations, including interleaved protocol replies.
- Exercise pause during feed/capture, original-FD handoff/resume, failure while
  paused, hangup with trailing output, continuous output fairness, and safe
  destruction. A socket-only transport fixture is insufficient.
- Run validation before serialized timed ABBA pairs. Hold the global CPU lock,
  use one established NUMA/L3 affinity set, observe SMT siblings, and archive
  the frozen term DSO plus helper/source hashes. No runs overlap other agents.

The main uncertainty is whether avoided main-thread callbacks and allocations
outweigh mutex traffic, parser/capture contention and retained notification
work. This experiment measures that uncertainty without committing Corgi to a
threaded production terminal API.

## Source draft, not yet compiled or run

`pty_actor.c` implements the benchmark actor and its shared real-PTY producer.
`pty_actor_costs.ts.fixture` is the unverified TypeScript companion. Its fixture
extension keeps unfinished benchmark code out of unrelated format/validation
runs. Copy it as `pty_actor_costs.ts` into the independently frozen V14 source
tree for validation. The harness refuses source/native hashes or a Bun version
that differ from the supplied production V14 build receipt.

The default actor uses EPOLLONESHOT and rearms on the worker after each bounded
service. That preserves the per-readiness rearm operation in the first ownership
comparison. `--level-triggered` is an additional, explicitly separate mechanism;
it must not be mixed into the read/feed-only claim. The helper reports lane
epoll_ctl counts. A pause sets stop, wakes and joins; restart rearms every
one-shot registration, including any event consumed by epoll_wait just before
stop but not serviced.

Notifications use a nonblocking socket and a bounded8192-record queue. A full
queue is a fatal experiment error, not a silent dropped receipt. Partial writes
retain their byte offset, and socket WRITE readiness retries queued records.
The dirty mask is set before the corresponding notification is queued. The
visible-only variant keeps hidden dirty bits received alongside visible wakes
until the ordinary50ms maintenance pass dispatches them. Per-consumer native
revisions still determine what capture/observation sees.

The fixed source corpus includes UTF-8 wide/combining text, split control
sequences, styles, OSC8 links, titles, OSC52 clipboard updates, scrolling,
bracketed-paste mode changes and DSR replies. Every mode performs the same Bun
maintenance/capture/observation jobs. The producer writes256-byte records with
NUL padding; this is an explicit component fixture, not an assertion that its
parser mix equals the whole application. It uses one separately accounted
native producer thread for all raw PTY slaves. Its buffers and descriptors stay
owned until join.

The written verification paths compare each saved visible surface to a reference
replay of that exact fed-byte prefix, then compare all sixteen final surfaces,
modes, title text, clipboard and serialized input/protocol-reply bytes. Reference
VT creation happens only after joining the actor. Verification fragments writes
to7bytes and exercises the1MiB input-backpressure bound, a queued WRITE drain,
pause with no later feed, reading the original FD while paused, and restarting
after a simulated later handoff failure. These checks have not run. Timed passes
exclude reference replay and retain ordinary allocation/GC settings.

The first validation slot should compile with:

```sh
cc -O3 -std=c11 -Wall -Wextra -Werror -fPIC -shared -pthread tools/benchmarks/pty_actor.c -ldl -lutil -o /tmp/pty-actor-v14.so
```

Record this command and compiler/helper/source hashes. Under the global lock and
the established NUMA observer, run all three modes (`ready`, `actor-all`,
`actor-visible`) with both schedules (`aligned`, `staggered`) and `--verify-only`
before timed ABBA pairs. Set `CORGI_NATIVE_ROOT` to the verified frozen native
copy and `PTY_ACTOR_REFERENCE` to the V14 `.build.json`. The TypeScript harness
checks both, records endpoint per-thread user/system ticks, and reports total,
Bun-main, producer and native-actor CPU separately. Consumer total subtracts
only the explicitly identified producer CPU.

This draft still needs focused compilation, runtime verification and review.
Dedicated synchronized-output expiry, trailing-output hangup, sustained flood
fairness, lock-contention diagnostics, and broader process-global VT dependency
tests are still required before treating it as production-safe. No production
code, cadence or threading policy has changed.
