# PTY poll versus epoll gate

Source prepared, not compiled, checked or measured. Production V16 remains
rejected and archived. This is a narrow backend test using the existing native
actor fixture, not restoration of a production reader.

Build `pty_actor.c` twice with otherwise identical flags: ordinary epoll and
`-DACTOR_POLL=1`. Run both with `--level-triggered`; the poll helper explicitly
rejects one-shot mode. The default epoll/one-shot behavior remains available for
the existing fixture. New wait counters are in a separate export so the existing
14-field actor stats ABI is unchanged. Rebuild both helper libraries from the
same new source rather than comparing a new poll helper against an old binary.

The poll adapter constructs 17 `pollfd` entries for 16 active PTY masters plus
the control eventfd. It adds the notification FD only while a partial queued
notification needs writable readiness. It maps the returned flags into the same
service loop used by epoll. Both paths retain the same 8×64 KiB bounded drain,
native feed, protocol/user-input flush, lane mutexes, dirty mask, visible-only
notifications, FIFO/partial notification queue, control wake and pause/join.
The same helper owns all FDs/lanes until join. No raw pointer lifetime or dynamic
registration policy is changed by this gate.

The new cumulative counters record actual wait calls and returned ready entries.
They use the same atomic increments in both backends. Existing actor stats record
read/feed/EAGAIN counts and worker CPU; existing per-thread `/proc` snapshots
split worker user and system ticks. Report tick granularity explicitly: at
100 Hz, one thread tick over 30 seconds is about 0.033 percentage points of a
core. Whole-process CPU and worker CPU-clock totals provide finer total-CPU
measurements, but do not invent finer user/system resolution.

## Prospective narrow comparison

- One workload: `actor-visible staggered --level-triggered`, 16 real PTYs,
  20 Hz per lane, 20 Hz visible capture, 20 Hz all-pane maintenance, 4 Hz
  all-pane live-text/title observation. Same frozen V14 terminal/source inputs.
- Two builds, balanced order: epoll, poll, poll, epoll. Each uses 10 seconds
  warmup and 30 seconds measurement. No aligned or all-notified matrix.
- Reuse the existing exact-prefix/final-surface, duplex input, original-FD
  handoff and partial-notification restart verification before timing. Both
  helpers must deliver equal bytes and pass the existing producer phase guards.
- Preserve raw results and exact source/library hashes. Use the scheduled CPU/
  NUMA placement, clamp and SMT-noise policy; no profilers during timing.
- Primary attribution is worker system CPU alongside process/consumer CPU,
  wait/service counts and notification frequency. A reduction bought by missing
  reads, weaker observation cadence or different notifications is not a backend
  win.

## What this can and cannot establish

The archived V16 reader rebuilds/scans its poll array and pins all entries on
each wait (`native/pty_reader.c:76–109,125–152`). Its arrays are retained and grow
only on capacity changes; there is no per-wake `calloc` in the stable case.
The system CPU increase could include poll setup, mutex contention, control
wakes, reads or notification syscalls. The supplied V16 net +0.217 system-core
points would be about 6.8 μs per offered update at 320 updates/s if divided that
way, but actual wait/service frequency must come from measurements.

This gate isolates the shared actor's persistent epoll registration versus
per-wait poll setup and scanning. It does not reproduce V16's dynamic registry,
all-entry reference snapshots or full-product Bun activity. A positive result
justifies a separate archived-V16 backend experiment; it does not establish a
production saving.

That faithful follow-up must preserve V16's snapshot reference ownership,
VT→registry lock order, synchronous detach/final receipts and WRITE-interest
updates. Persistent readiness records must use never-reused registration IDs
and match a pinned current registration before service; cached kernel events
must not dereference freed entries or service a reused FD. Linux epoll alone
also says nothing about the macOS backend. These are reasons to gate the larger
change with this small measurement first.
