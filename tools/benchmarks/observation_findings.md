# Observation and workspace cost mechanisms

Baseline: PR #15, `fb129d2`. This is a source audit plus isolated experiments;
microbenchmark savings must not be presented as whole-daemon savings.
The benchmark scripts use synthetic data and private temporary files/repositories.
No live provider requests or user transcript contents are needed.

## Work that the previous CPU matrix omitted

`tools/ui_driver.ts` creates an empty directory, not a Git repository. Its fake
Codex agents have no UUID title that binds them to an app-server thread, and its
transcripts contain minimal records. The four idle/streaming and
attached/detached cells are useful terminal workloads, but they do not account
for these real-session costs:

- Regular Git repositories, linked worktrees, upstream comparisons, and an open
  worktree overview.
- Codex app-server RPC polling, including history scans for working-directory
  evidence and child-agent state.
- Nonempty usage/model/context records that continue publishing unchanged
  observations after the transcript reaches EOF.
- Resource history that has filled its 48 five-second buckets. Short benchmarks
  start with mostly empty history.

## Recurring work and scaling

| Component | Trigger | Work and scaling | Main source |
| --- | --- | --- | --- |
| Daemon collection | Timer wakes every 50 ms; quiet collections coalesce to at least 250 ms | Scans panes and service schedulers; active output keeps 20 Hz collection | `src/server.ts` |
| Foreground detection | At most every 250 ms; quiet panes can wait 2 s | One foreground-group probe per due pane, executable/group reads; own descendants when identity is uncertain | `src/observer_service.ts`, `src/detection.ts` |
| Screen observation | Due detection; lazy text capture when a watcher needs it | Native visible-screen materialization, then provider text rules; active/blocked panes continue observing without new output | `src/providers/watcher.ts`, `src/runtime.ts` |
| Agent change detection | Every `detectPane` | Serializes the full Agent twice for comparison | `src/observer_service.ts` |
| Usage tails | 250 ms worker tick, up to 64 requests per pass | One lstat at unchanged EOF; growing file adds open/fstat/lstat/read/close and up to 64 KiB parsing | `src/usage/worker.ts` |
| Pending-stop transcript verification | 250 ms, relaxing to 2 s after 20 attempts | Only pending-stop agents; open/fstat/lstat each attempt, reads up to 64 KiB | `src/transcript.ts` |
| Codex observation | 500 ms worker tick, one pass in flight per account | Reconnect/init, loaded-thread listing, then sequential per-session RPCs; max 64 requests/pass | `src/providers/codex/observer.ts` |
| Git branch/push state | 3 s | Each workspace; main checkout has metadata shortcut up to 60 s, linked checkout does not | `src/trackers/git_status.ts` |
| Worktree inventory | Scheduler 3 s, cached inventory 10 s | Shared by common repository; inventory and branch refs, association of agents with checkouts | `src/trackers/worktrees.ts` |
| Worktree details | While overview open, 3 s | Status and diff per linked checkout; up to 1,000 changed files checked; untracked text up to 1 MiB counted | `src/trackers/worktrees.ts` |
| Resource sampling | 2 s; 1 s with detail open | Own process trees, stat+I/O per process, host counters, optional GPU attribution; histories cloned across worker boundary | `src/trackers/resources.ts`, `src/trackers/resource_os.ts` |
| Ports | 3 s | Own process trees and sockets/descriptors; unknown listeners inspect output/arguments, announced listeners get HTTP probes | `src/trackers/ports.ts` |
| Activity inference | Scheduler 250 ms; actual work gated by evidence/cooldowns | Agent reconciliation, names, usage, and optional model requests; model CPU is external | `src/activity/worker.ts` |
| Launcher/account preview | Checks due work every 15 s; account reads every 150 s while viewer recently active, otherwise 600 s | Provider discovery/login/usage reads; initial and explicit refreshes have separate triggers | `src/launch/preview.ts`, `src/launch_service.ts` |
| Worktree briefs | Only an opened overview or explicit refresh schedules requests | Change fingerprints and optional inference; not an always-running per-checkout model call | `src/worktree_briefs.ts` |
| Recovery save | Durable change delayed 2 s, at most 10 s continuously dirty | Serialized durable state and terminal recovery data; separate from ordinary resource refresh | `src/server.ts`, `src/persist/recovery.ts` |

Counts above are from source, not measured CPU percentages. Costs depend on
panes, followed conversations, descendants, workspaces, linked checkouts,
history length, and bytes of appended transcript/output. Total host process
count matters mainly on fallback paths; Linux normally follows owned trees.

## Four structural opportunities

### Preserve semantic identity through observation

`usage.Worker.reconcile` clones every followed Agent at 4 Hz. `Agent.snapshot`
constructs a default Agent, overwrites it, then copies nine bounded text values
by encoding them as UTF-8 and decoding them again. The strings are already
bounded and immutable. Default construction creates ten text wrappers which
are subsequently discarded; nine more wrappers hold copied text.

`observation_costs.ts` compares the production snapshot against a compact
prototype that keeps the same independent wrappers and observation state but
copies validated immutable strings directly. Fixture equality and mutation
independence are asserted. This is a diagnostic implementation: production
should give bounded text an explicit clone/copy operation instead of relying
on `Object.create` at unrelated call sites.

Separately, unchanged EOF is not equivalent to no observation. Once a tail has
a model, name, context, or previous spoken timestamp, `usage.Worker.run` still
creates a Result at every poll. `observer_service.tick` then calls
`changed(server)` for every result. Skipping unchanged filesystem reads leaves
this downstream invalidation intact. That function increments the runtime's
visible revision and durable revision: the effect includes viewer wakeups,
rebuilding and hashing session snapshots, and repeated recovery serialization
and writes, not merely the allocation of a small Result. Viewer sync suppresses
the session payload when its hash is unchanged; these invalidations do not
necessarily send the full session over the socket. Ordinary subscribers use a
different publication path. The script exercises the actual worker at unchanged EOF to count
emissions. `observation_costs_fixture.ts` adds an optional historical Claude
model/usage/context record to the CPU harness without changing its terminal
output or hook sequence. In a sixteen-agent alternating fixture, eight Claude
tails can emit 32 unchanged results/second at the 250 ms worker cadence.
A fix must preserve the rolling recent
token window, continuation, pending completion, and provider name updates;
blindly skipping every EOF result is incorrect.

### Keep resource sampler state in its existing worker

The worker already persists, including its GPU sampler, yet every sample
receives `batch`, `current`, `origins`, and roots. It restores both snapshots
and constructs a new Tracker, computes a result, then returns the full next
batch. `batch.view` and `current` commonly alias before transfer; structured
clone preserves that alias, but separate restoration walks rebuild both.
History contains 48 buckets, with process leaders inside each bucket.

The prototype measures exactly the clone/rehydration part against sending only
roots/options while retaining previous state in the worker. Both paths return
the same full output. The comparison excludes process reads, sampling logic,
and thread scheduling, so it quantifies an avoidable transport component and
does not claim to be a complete sampler replacement. A product change needs
ownership validation, worker restart recovery, handoff, and stop semantics.

### Bound text extraction before crossing the native boundary

`common.screenTail` trims and splits the whole visible screen, retains eight
rows, joins them, caps at 8,192 characters, then lowercases. Codex status and
background-terminal checks perform related splitting again. A backward newline
scan gives the exact same tail without an array proportional to all rows.
The script checks empty strings, trailing Unicode whitespace, long lines, and
screen-sized fixtures. Larger fixtures demonstrate scaling; a normal 48-row
screen remains the relevant baseline, not the 2,000-row stress case.

This only removes TypeScript work after native text capture. A more material
pushdown would expose the required visible rows directly, retaining the full
screen path for Claude's composer detection, which scans all rows.

### Stop fetching unchanged Codex history

Each ordinary bound session snapshot calls `thread/read`,
`thread/turns/list`, `thread/items/list` for location,
`thread/backgroundTerminals/list`, and `thread/list` for children. An active
parent with children may also scan items for a wait tool. Location walks
backward until it finds an edit/command directory; with no such evidence it can
traverse up to 32 pages of 100 items on every 500 ms pass. Idle state does not
skip these calls. All replies go through `json.parse` with a reviver to preserve
large integer tokens, allocating the decoded object tree before the requested
signals are extracted.

The deterministic RPC audit invokes the real `snapshot` function using encoded
fixture replies, counts method calls and response bytes, and verifies the
result. It excludes socket/provider CPU and is not a real-session latency
measurement. Caching by a coarse `updatedAt` alone is not a demonstrated fix:
the invalidation contract must cover child changes, background terminals, and
in-progress items. A provider revision or delta stream is the clean boundary.

## Git fixture

`observation_costs_git.ts` constructs one private repository with sixteen small
tracked files and sixteen linked worktrees, all tracking a local `origin/main`.
After warming production `Tracker.refreshInto`, it compares no repository,
one main workspace, sixteen aliases of that same workspace, one linked
workspace, and sixteen different linked workspaces.

The audit uses Git's trace file outside timing to verify command counts. Warm
main checkout and non-repository cases issue zero Git commands; each linked
checkout with upstream issues five even when unchanged. Timed calls use
distinct virtual timestamps inside the 60-second main-checkout metadata cache
window, excluding cold queries and setup. `/proc/self/stat` includes separately
reported reaped child CPU with the host's clock-tick resolution. Costs scale
with actual tracked workspaces, not merely with how many linked directories
exist elsewhere on disk.

The benchmark includes a compact linked-checkout prototype which resolves
gitdir/common-dir and stamps HEAD, configuration, loose refs and packed refs.
It verifies branch commits, upstream updates, branch checkout, tracking config,
and packing/pruning refs against a fresh production tracker. The prototype
still checks the pointer files and retains a 60-second full refresh. It does
not establish full correctness for submodules, reftable, included configs,
common-dir replacement, or filesystem changes during a read. Production needs
explicit lifecycle and invalidation coverage for those cases. Disabling Git
tracking or using a stale unconditional cache is not equivalent.

## Instrumentation interpretation

Measure actual asynchronous bodies (`git_status.Tracker.run`,
`worktrees.Tracker.run`, `ports.Tracker.scan`) rather than just their `tick`
schedulers. Resource CPU is in `Tracker.sample` inside a worker. Synchronous
spans can approximate event-loop occupancy; async span duration includes waits
and overlaps and cannot be added as CPU. Separately retain process CPU,
child-process CPU, bytes/records, calls, and invalidations so the explanation
distinguishes expensive computation from many cheap unnecessary passes.

## A prototype for semantic observation changes

Do not turn the EOF shortcut into an unconditional early return. The worker
currently combines three different kinds of input in one Result:

- New transcript facts: tokens, model/context, tools, continuation, text, and
  completed background tasks.
- External names: Codex's `reader.refresh` and `reader.name` can change a name
  while the transcript itself stays at EOF.
- Clock-derived presentation: `Meter.view(now)` expires the five recent-token
  buckets at minute boundaries, without new transcript bytes.

The first experiment should retain the latest observation as worker-owned
state and give it a semantic revision. A successful ingest/open/error transition
or a changed provider name revises that state; unchanged lstat results do not.
The cheap clock check only recomputes recent tokens on a minute boundary and
publishes a display update if their value actually changed. Immutable strings
and stable context/model objects can be retained until their revision changes.
This avoids using serialization as a local equality operation.

The consumer also needs to distinguish observation arrival from a Corgi state
change. Apply the latest facts and return whether durable state, only display
state, or nothing changed. Use `runtime.changed()` for genuine durable changes
and `runtime.refreshed()` for derived display-only updates; a no-op calls neither.
Combining results into one invalidation per observer pass is simpler, but does
not alone fix the repeated 4 Hz pass: the source still needs change awareness.

For Codex snapshots, keep freshness separate from the semantic revision:
`Actor.authoritative()` trusts protocol state for only five seconds after
`state.protocol_at`. An unchanged successful observation must still refresh
that heartbeat without automatically dirtying presentation and recovery.
Otherwise the optimization silently hands authority back to screen detection.

Keep latest facts available for changes on the consumer side. A hook/new turn,
attachment or workspace change can make an unchanged observation relevant
again. In particular, clearing completed-task facts after their first delivery
would lose a delayed hook that introduces the task afterward. Preserve token
baselines and meter loss state across reopen/rotation, and let a newly restored
worker publish its initial state once. No persistent or wire schema needs to
change merely to add internal revisions, but the existing recovery behavior
must be checked rather than assumed.

The validation set for that experiment should include: idle rich transcript
with no invalidations after settling; first appended record; unchanged model
with new tokens; five-minute token expiry at a minute boundary; Codex name
change without file growth; new turn and workspace visit without growth;
late task hook after completion; rotation/truncation/read failure and recovery;
and restart/handoff without double-counting. The macro comparison should retain
the same screen updates and metadata visibility. This recommendation is not
an implemented or measured production fix.

## Measurements, 2026-10-25

Both placements used the same installed Bun 1.4.4 and PR #15 native libraries
on an AMD EPYC 7C13 host. Runs were serial under the shared benchmark lock:
CPUs 8–15 with memory bound to NUMA node 0, then CPUs 72–79 with memory bound
to node 1. SMT siblings were excluded from each binding. No downloads/builds
are included. These are warm service costs, not startup measurements.

Each synchronous microbenchmark has six 250 ms samples per variant per node,
after one warmup per variant, alternating variant order. CPU includes Bun
threads and GC occurring in the measured loop; a forced GC precedes each
sample. The following values average the two within-node medians. Raw samples
also contain wall time; no claim of precise allocated-byte counts is made.

| Operation | Production CPU | Compact CPU | Local ratio | Effect at stated cadence |
| --- | ---: | ---: | ---: | --- |
| Copy 16 Agents | 117.2 µs | 45.6 µs | 2.57× | Saves 0.029 percentage points of one core at four batches/s |
| Extract eight rows from 48-row screen | 2.66 µs | 0.87 µs | 3.06× | Saves 0.011 points for 16 panes observed four times/s |
| Extract eight rows from 200-row screen | 7.53 µs | 0.93 µs | 8.05× | Stress/scaling case |
| Extract eight rows from 2,000-row screen | 64.45 µs | 0.92 µs | 69.8× | Stress/scaling case, not a normal visible screen |
| Resource transport: one workspace, 16 processes, full history | 1.154 ms | 0.529 ms | 2.18× | Saves 0.031 points at one sample/2 s |
| Resource transport: eight workspaces, eight processes each, full history | 8.620 ms | 3.917 ms | 2.20× | Saves 0.235 points at one sample/2 s; twice that with detail open |

The screen-tail and Agent-copy results show unnecessary representation work,
but their absolute cost is small at these scene sizes. They do not justify
large architectural machinery. Resource state ownership saves more as the
number of mature workspace histories grows; it still explains only the
transport part of the sampler.

The cadence columns are modeled estimates from these microbenchmarks, not
rigorous upper bounds on whole-application savings. Allocation lifetimes,
caches, garbage collection, bursts, and competing work can change those costs
inside the running application.

The Git benchmark has eight repetitions of four sweeps per case per node,
reversing case order on alternate repetitions. Child CPU has 10 ms accounting
resolution and is averaged across all sweeps. The linked-workspace prototype
passed all six mutation checks on both nodes.

| Warm Git status sweep | Git commands | Mean wall | Self + child CPU | CPU at one sweep/3 s |
| --- | ---: | ---: | ---: | ---: |
| Empty directory, one workspace | 0 | 0.002 ms | 0.002 ms | <0.001% |
| Main checkout, one workspace | 0 | 0.082 ms | 0.138 ms | 0.005% |
| Main checkout, 16 workspace aliases | 0 | 0.622 ms | 0.972 ms | 0.032% |
| One linked workspace | 5 | 11.03 ms | 11.73 ms | 0.391% |
| One linked workspace, compact | 0 | 0.113 ms | 0.169 ms | 0.006% |
| Sixteen linked workspaces | 80 | 176.51 ms | 192.62 ms | 6.421% |
| Sixteen linked workspaces, compact | 0 | 1.313 ms | 2.522 ms | 0.084% |

Most linked-workspace cost is in child Git processes: about 151 ms of the
193 ms total for sixteen workspaces. A daemon-only CPU counter misses that.
One workspace containing sixteen agent tabs still pays the one-workspace
cost; merely having sixteen linked directories does not imply sixteen tracked
workspace scans. Opening the worktree overview adds a different per-checkout
status/diff workload that this benchmark does not measure.

The Codex fixture uses roughly 1 KiB of message text per item. Timing includes
fake-server JSON serialization, the production client parser, and the actual
snapshot extraction logic; it excludes sockets and the real provider process.
Six 250 ms samples per case per node follow a warmup. These are different
history shapes, not equivalent implementations or end-to-end speedups.

| One idle bound-session snapshot | RPCs | Response bytes | CPU | Wall |
| --- | ---: | ---: | ---: | ---: |
| 100 items with no location evidence | 5 | 110,276 | 0.235 ms | 0.218 ms |
| 3,000 items with no location evidence | 34 | 3,306,356 | 6.572 ms | 6.237 ms |
| 3,000 items; latest command in new turn, followed by older turn | 5 | 109,292 | 0.219 ms | 0.210 ms |

The large case reconstructs at least 6,000 history entry/item objects per
snapshot before discarding them. At sixteen sessions and two polls/s its
response traffic alone would be 100.9 MiB/s, compared with 3.34 MiB/s for the
early-stop case. That rate is a fixture extrapolation, not observed live
traffic. Actual polling slows when a whole account pass cannot finish inside
500 ms; the worker does not overlap passes. A long active turn can also keep
the backward search inside the same turn even when its newest item is a
command. Provider latency and history shape must be measured on a separate
realistic app-server fixture before converting this into daemon CPU savings.

The unchanged-EOF audit returned one usage Result on every one of four polls
of an unchanged three-byte file after seeding an already-known model. That is
a verified control-flow result. The optional rich-history fixture measures
the resulting publication/recovery cascade separately in the full application.

### Host resource sampling decomposition

The resource worker consumes about 0.66–0.71% of one core in the parent
experiment, equivalent to roughly 13–14 ms per two-second sample. A focused
follow-up checked whether asking `os.cpus().length` for the host's 256 logical
CPUs explained that cost. It does not in repeated-call measurements.

The compact prototype counts `cpuN` rows in the existing `/proc/stat` input,
keeps the same aggregate CPU, memory, and pressure formulas, and falls back to
`os.cpus()` when rows are unavailable. It refreshes core count every call, so
CPU hotplug is reflected in the same snapshot as aggregate counters; it does
not substitute affinity-limited CPU availability or introduce a stale cache.
Sixty-eight fixed-input checks cover 1/16/256 CPUs, sparse CPU IDs, missing or
malformed proc inputs, pressure thresholds, and memory beyond 2^53. The fixed
baseline parser copies the production Linux parsing expressions; live timing
calls the actual imported production `host()`.

| Per operation, node 1 medians | CPU | Wall |
| --- | ---: | ---: |
| Production `host()` | 514.3 µs | 479.3 µs |
| Compact `host()` | 461.6 µs | 452.8 µs |
| `os.cpus().length` | 51.5 µs | 32.0 µs |
| Read `/proc/stat` as text | 413.6 µs | 408.8 µs |
| Read memory pressure | 33.5 µs | 33.3 µs |
| `os.totalmem()` | 0.455 µs | 0.452 µs |
| Fixed baseline parser | 8.77 µs | 7.31 µs |
| Fixed compact parser | 8.76 µs | 8.49 µs |

At one call per two seconds, the measured whole host read models about 0.026
core percentage points; replacing CPU inventory models only 0.0026 points.
The 27,902-byte `/proc/stat` read is the largest host component. The remaining
worker cost needs separate inventory/task-tree and GPU attribution; this host
has two NVIDIA devices, and the production worker polls several NVML APIs for
each device, including process lists and utilization history.

Six 100-ms samples per case alternate order. Node 0 results agree closely,
but one SMT sibling was busy for 56% of its invocation; node 1 siblings were
all below 0.41%, making node 1 the primary result. These are warm repeated
calls, not proof of the runtime's CPU-inventory caching behavior or of costs
after a two-second idle gap. Raw samples and source hashes are in
`dist/observation-costs/host-node{0,1}.json`; no production code changed.

### Full-application EOF mechanism

The first sixteen-agent telemetry comparison used eight Claude agents and
eight screen-tracked Codex agents. Rich mode adds historical model, usage,
context, and text to the eight Claude transcripts. During all four measured
15-second windows, neither mode ingested any new usage-transcript bytes.
Minimal mode produced no usage Results or `runtime.changed` calls; rich mode
produced about 32 of each per second. The duplicated observations therefore
come from retained EOF state, not repeated transcript parsing.

The normal viewer received no full session payloads during either mode's
measured windows (`viewer.session` remained zero). Hash suppression works:
the unnecessary work occurs before it, and in wakeups and recovery.

| Node 0 telemetry, minimal → rich | Idle, attached | Streaming, attached |
| --- | ---: | ---: |
| Viewer sync calls/s | 1.73 → 4.00 | 20.59 → 24.53 |
| Viewer composition calls/s | 9.40 → 12.66 | 23.33 → 24.53 |
| Daemon wire bytes/s | 701 → 1,300 | 184,060 → 185,096 |
| Session payloads applied/s | 0 → 0 | 0 → 0 |

Rich mode wrote six recovery snapshots during each idle 15-second window,
versus none for minimal mode. Recovery occupied 3.87 ms/s of wall time when
idle attached, and 10.86 ms/s when idle detached after the earlier streaming
phase had accumulated terminal history. These are wall spans, not additional
CPU percentages. Streaming already dirties recovery state through
`runtime.wrote()` on terminal changes, and both modes saved about once every
two seconds while streaming.

The node 0 minimal run had excessive average sibling load (13%), so its CPU
differences are not a clean causal estimate. Even without that noise, the rich
fixture also changes actual sidebar model/context/activity content. A CPU
comparison measures the richer workload; assigning all of its difference to
EOF invalidations would require a prototype retaining identical UI state while
suppressing only semantic no-ops. The counters above directly establish the
mechanism without making that stronger claim.

The reverse-order node 1 repeat used a 30-second initial warmup, 15-second
later warmups, and 20-second samples. It reproduced exactly 640 usage Results
and 640 `runtime.changed` calls in every rich phase, with zero ingests, versus
zero in minimal mode. Full session payloads were again suppressed in all
measured windows.

| Node 1 telemetry, minimal → rich | Idle, attached | Streaming, attached |
| --- | ---: | ---: |
| Viewer sync calls/s | 1.949 → 3.998 | 20.445 → 24.444 |
| Viewer composition calls/s | 7.097 → 9.745 | 20.445 → 24.444 |
| Daemon wire bytes/s | 769 → 1,308 | 183,169 → 184,166 |
| Session payloads applied/s | 0 → 0 | 0 → 0 |

Rich mode completed nine recovery writes in each idle window versus zero for
minimal mode. Those writes occupied 4.96 ms/s of wall time attached and
24.19 ms/s detached after history accumulation. Streaming modes both
completed about one recovery write every two seconds. The larger detached
recovery spans reinforce that retained terminal history matters; a fixed
per-result CPU charge would misrepresent the cascade.

The node 1 richer-workload CPU differences, in percentage points of one core,
were +1.00 daemon/+1.25 viewer when idle attached, +1.10/+1.00 when streaming
attached, -0.30 daemon when streaming detached, and +0.80 when idle detached.
They remain scenario differences, not an estimate of the savings from
eliminating EOF duplicates while preserving identical displayed state.

### Telemetry interpretation and review

The instrumentation preserves the original operation ordering and exception
paths. Resource-worker diagnostic messages flush directly without invoking a
sample or sending a sample result. Registration follows worker creation,
close, and error teardown. Only enabled telemetry installs the SIGUSR2 export
handler; the browser replacement does no work.

Intervals measure elapsed wall time, including awaits and descheduling, and
parent/child spans overlap. The resource sample interval excludes structured
clone transport and reconstruction, so it cannot be presented as the complete
sampler cost. Worker `process.cpuUsage()` describes the whole process and must
not be added to the main-thread CPU fields. Aggregate phase deltas count
completed spans; a span started before a boundary contributes its full duration
when it completes. Export happens outside CPU windows. The diagnostic
`Buffer.byteLength` calls for compose and wire decode are included in those
spans, a small attribution bias whose size has not been isolated.

Host samples span complete invocations, including setup, rather than individual
variants. The largest average SMT-sibling busy reading was 0.69% for Git/node 0,
1.67% for microbenchmarks/node 1, and 4.07% for Git/node 1. The first microbenchmark
invocation lacks a host sample; the node 1 repeat agrees within roughly 2–7%
for the material operations. These are shared-host estimates and do not rule
out brief interruptions.

Raw results, affinity, checksums and host samples are in
[`dist/observation-costs`](../../dist/observation-costs), with
[`provenance.json`](../../dist/observation-costs/provenance.json) recording
the baseline and source/native hashes. The first attempted verification caught
a missing own `raw_bytes: undefined` property in the compact text wrapper;
it was corrected before any reported timing, after which exact deep equality
and mutation independence passed.

## Resource attribution followup

The final instrumented application splits the sample body into process inventory,
host counters and GPU work. Ten real-cadence samples with sixteen agents and two
host NVIDIA devices averaged 13.014 ms elapsed: GPU read/attribution 6.430 ms,
owned process/task inventory and counters 4.876 ms, host counters 1.284 ms, and
remaining aggregation 0.424 ms. Worker CPU was 0.78% of a core. These stage
wall spans include waits and are not individual CPU measurements.

This identifies GPU polling and process inventory as the larger resource costs.
The host-counter microbenchmark is too small to explain them; its warm timings
also differ from the application's two-second cadence. GPU sampling includes
NVML device/process/utilization queries even without agent GPU workloads.
Demand/cadence changes require an explicit freshness contract. Raw snapshots,
per-thread CPU and host-load samples: `dist/telemetry-resources-final/`.

## Retained sidebar followup

Herdr's client applies pane patches directly to its retained composed surface
(`src/client/mod.rs:1559`, `src/client/shell/surface_patch.rs:109` in the checked-out
v0.9.5 source). The server compares dirty pane rows and sends changed contiguous
cell spans, including the following cell for wide-character transitions
(`src/server/headless/retained_surface.rs:48`). Its client timeout path requests
shell composition for explicit selection, notification, feedback, highlight and
error changes (`src/client/mod.rs:2311`); the sidebar renderers have no continuous
clock-driven spinner or corgi equivalent. The process comparison therefore also
contains a visible animation workload difference.

Corgi's retained sidebar changes preserve its existing animation deadlines. V8
retains outer chrome but redraws the complete sidebar. V9 prepares static sidebar
chunks and explicit agent detail-row fragments, advances the existing animation
presentations, and patches only fragments whose ANSI bytes changed. Full fallback
is a lazy join of immutable current fragments; it never invokes animation drawing
again. Enter/exit/move, lost identity holds, ghost borders, spotlight, and workspace
push/naming animations retain the complete sidebar path. These are architectural
work reductions, not measured CPU savings until the isolated V9 runs complete.

## V12 CWD lookup experiment

Decision: reject the Linux native lookup wrapper from the product. Preserve the
smaller direct runtime call, delayed foreground query, fallback-order tests and
`agent.cwd` telemetry. The exact rejected source, tests, harness, DSOs, raw results
and SHA-256 manifest are archived in `dist/cwd-v12-prototype/`; the active source
tree no longer contains the prototype-only benchmark or tests.

The V9 sparse profile attributes 161 of 2,010 sampled daemon main-thread stacks
to `Pane.refreshCwd` (8.01%); 143 end in `readlinkSync` and fourteen in
`tcgetpgrp`. These sample shares rank work, not predicted process CPU savings.
`Server.collect` refreshes CWD after terminal output; the candidate preserves
that cadence. Explicit spawn, close and idle-shell queries still refresh it too.

The candidate reads Linux `/proc/PID/cwd` through the existing mechanical native
function into one caller-owned buffer. It retains the original Bun lookup when
the result may exceed the buffer, preserves missing/error results, and prevents
out-of-range numeric PIDs from wrapping across the FFI boundary. Separately,
`Pane.refreshCwd` calls `os.processCwd` directly and delays the foreground query
until its preferred detected-PID lookup fails. It preserves fallback order and
retries, including repeated PIDs; it caches no CWD result. The `agent.cwd`
telemetry span measures the complete refresh body, including fallback queries.

The archived `source/tools/benchmarks/cwd_costs.ts` compares the old Bun lookup
with the prototype `processCwd`.
It changes a live child's directory during exact verification, then alternates
six 100 ms samples per case. CPU0/memory-node0 and CPU64/memory-node1 ran
serially under the global lock. Both passed eighteen exact checks; each SMT
sibling was 0% busy and total host busy was about 1.28%.

| Lookup | Node 0 old → new CPU µs/op | Node 1 old → new CPU µs/op |
| --- | ---: | ---: |
| Current process | 2.548 → 2.472 | 2.786 → 2.496 |
| Live child | 2.801 → 2.687 | 3.107 → 2.849 |
| Missing process | 3.770 → 2.307 | 4.101 → 2.560 |

Valid lookups improve only 3–10% (about 0.1–0.3 µs); missing lookups improve
37–39% by avoiding Bun exceptions. This does not support a large daemon saving
from changing the lookup wrapper alone, and did not justify its native/error/
fallback machinery. The hot-loop fixture does not measure the separate
foreground-query elimination or the application's colder output-driven cadence.

Validation: pinned ReleaseFast native install plus `test-pane` and
`test-frame-diff`; 86 focused TypeScript tests with 16,537 assertions; formatting
and typechecking all pass. The long-path test uses libc directly because Bun's
`process.chdir` calls `getcwd` and rejects the test setup beyond its own buffer.
Capacity-boundary, overflow-fallback, child directory/deletion, PID validation,
and refresh fallback semantics have separate checks. Raw results and source/DSO
hashes are in `dist/retained-v12-cwd-node{0,1}.json`; validation logs use
`dist/retained-v12-{native,focused,format,typecheck}.log`.

## V13 fresh process-group membership

V11's sparse diagnostic records 180/1,065 daemon main-thread samples inside
`foregrounds` (16.90%). Sixty samples (5.63% of the main-thread sample set) are
under `processJob` membership checks. These include 29 `readSync`, thirteen
`openSync`, six `closeSync` and nine parsing samples. The complete foreground
span runs four times per second and measures 0.307% elapsed time; sample shares
and elapsed spans have different denominators and are not interchangeable.

Two predicates only needed `processJob(pid)?.pgid`: the previously detected
agent's membership and the discovered process-tree filter. On Linux that helper
allocates a zero-filled 1 KiB buffer, opens `/proc/PID/stat`, reads to EOF,
closes it, decodes the record, splits all remaining fields and validates five
numbers. For an ordinary short record, that is open/read/EOF-read/close to
obtain a value the kernel exposes directly through `getpgid`.

The candidate adds one mechanical native scalar and `os.processGroup`. Linux
checks a positive i32 PID and maps failed syscalls to null; other platforms keep
the existing `processJob` path. Only those two membership predicates change.
It caches neither process identity nor argv. Every detection pass still reads
argv and can notice an exec under the same PID; discovery cadence is unchanged.

The actual old helper and new helper were measured on both NUMA nodes under
the exclusive lock and `cost_probe`, with alternating sample order and reversed
initial order on node 1. Both runs passed thirteen exact checks. CPU0's SMT
sibling was 0.199% busy; the accepted CPU64 retry's sibling was 0.795% busy.
The original node-1 run with 4.17% sibling activity remains in the artifacts.

| Membership | Node 0 old → new CPU µs/op | Node 1 retry old → new CPU µs/op |
| --- | ---: | ---: |
| Current process | 11.448 → 0.226 | 12.795 → 0.231 |
| Inherited child group | 11.783 → 0.233 | 11.996 → 0.235 |
| Isolated child group | 11.716 → 0.229 | 12.074 → 0.234 |
| Missing process | 4.681 → 0.209 | 5.247 → 0.225 |

Valid membership CPU falls about 98% in these hot loops. Unlike the rejected
CWD wrapper, this removes acquisition and parsing of unnecessary data. Macro
daemon savings remain to be measured. Native build and 37 focused tests with
337 assertions passed, including live `setpgid` on the same PID, inherited and
isolated subprocess groups, exit, nonpositive/wrapping inputs, fresh argv and
filtering before argv reads. Raw results, source/native hashes, frequency and
sibling samples are in `dist/retained-v13-process-group-node*`.

Remaining argv work is different. `processArgs` already shares its 1 MiB scratch
buffer; it does not allocate 1 MiB each poll. It still creates views and arrays,
decodes the complete bounded cmdline, splits every argument and then copies the
first 256 into another array. The V11 profile attributes 96 samples (9.01%) to
that path, mostly file open/read/close. Avoiding a generic EOF read without
establishing procfs short-read semantics, or caching argv across execs, would
require additional correctness work; neither is included in this candidate.

Herdr also reads proc records, but consumes `comm` and process state as well as
group membership (`platform/linux.rs:625` in pinned v0.9.5). Its cmdline path
avoids remote-memory reads for uninterruptible/exiting processes and, on WSL,
already identifiable agent names (`platform/linux.rs:368,750`). It additionally
skips steady foreground process probes under authoritative lifecycle hooks
while the foreground group stays unchanged (`pane.rs:648–751`). That is a
different observation policy, not evidence that Corgi's fresh argv read can be
removed without changing the detection contract.
