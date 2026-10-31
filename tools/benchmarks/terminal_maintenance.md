# Where Corgi spends terminal-maintenance CPU

This report records the initial investigation. Its implementation/validation
section describes the instrumentation snapshot, before retained composition.
The subsequent implementation and its separate evidence are tracked in
[retained validation](retained_validation.md).
The historical product fixtures also left producer timing between panes
uncontrolled; see the [producer phase audit](producer_phase_findings.md).
Those observed CPU ratios are not phase-controlled comparisons.

Investigation baseline: [PR #15](https://github.com/tals/corgi/pull/15),
`fb129d2ef96511a3c727112e0d1df2191bb5b241`. Worktree:
`/home/t/dev/personal/corgi-terminal-costs-20261025`, branch
`perf/terminal-costs-20261025`. The frozen baseline binary is
`dist/corgi-pr15`; instrumentation is a separate `dist/corgi-telemetry` binary.
Herdr is the official Linux x86_64 v0.9.5 binary, not an assertion about its
latest release. Neither project’s main checkout was modified.

## Findings

The clearest default-product gap is **Corgi’s viewer**, not terminal input
parsing. At sixteen agents producing twenty lines/second each, one visible,
the Corgi viewer used 8.20% of one core versus Herdr’s 0.67% in short windows.
A Corgi-only run after two minutes of streaming still used 7.05%. Matching every
PTY’s dimensions preserved a 7.47-point viewer gap. Full UI composition,
replaying full frames through terminal emulators, and repeated presentation
work explain more than serialization alone. Bun/JSC auxiliary threads also
consume a material part of the process budget.

Some large costs are absent from that terminal fixture. Sixteen unchanged,
tracked linked workspaces cost about **6.42% of a core in recurring Git checks**.
A metadata-check prototype costs about **0.084%** on the same fixture. Rich
transcripts cause unchanged EOF observations to invalidate the runtime **32
times/second** for eight Claude sessions; these trigger rebuilding, hashing,
wakeups and idle recovery saves even without parsing new records.

Compact terminal prototypes are much faster at their own stages, but their
combined hot-loop projection is about **0.89 CPU percentage points** for one
132×47 pane at 20 Hz. That is not the whole viewer gap or a measured product
speedup. The highest-value direction is to preserve dirty state and semantic
identity across the whole pipeline, then move the remaining bounded operations
across a small native boundary.

## Product budget

100% CPU is one core. Means of two trials per product, reversed product order
on the second NUMA node:

| Workload | Corgi daemon | Corgi viewer | Corgi total | Herdr total |
| --- | ---: | ---: | ---: | ---: |
| Idle, viewer attached | 3.80% | 2.67% | 6.47% | 0.93% |
| Streaming, viewer attached | 12.33% | 8.20% | 20.53% | 13.83% |
| Streaming, detached | 9.17% | — | 9.17% | 7.23% |
| Idle after streaming, detached | 2.57% | — | 2.57% | 0.83% |

The streaming attached totals ranged 19.47–21.60% for Corgi and
13.73–13.93% for Herdr. In a separate pair with **all sixteen agent PTYs verified
at 132×47 (plus Corgi’s quiet shell)**, totals were 22.40% versus 14.13%; viewers were 8.00% versus 0.53%.
This confirms the viewer gap, but is only one pair and does not isolate the
causal effect of changing geometry.

Corgi’s streaming resident footprint averaged 110.4 MiB daemon plus 81.8 MiB
viewer; Herdr’s was 29.8 plus 14.9 MiB. These are process RSS, potentially
including shared pages, **not allocation rates or proof of a leak**. Outer
terminal output was 26.4 versus 9.7 KB/s. Both passed visible progress/cadence
checks. The benchmark excludes provider CPU and the PTY consumer; it includes
all measured process threads. Child CPU is separately recorded waited-for
child time, not a complete live process-subtree total.

See [the comparison report](herdr_findings.md) for raw data, exact dimensions,
quality checks, source evidence and reproduction commands.

## Separating animation, main-thread work and runtime work

A same-placement diagnostic with 30 seconds initial warmup, 15 seconds between
later phases and 20-second windows compares the ordinary `corgi_intensity=50`
with `0`. Turning off decorative Corgi motion reduced idle viewer CPU from
**2.50% to 0.95%**, compositions from 7.10 to 2.55/s, and maintenance passes
from 30.49 to 4.99/s. Streaming viewer CPU was **7.35% versus 7.65%**, with
nearly identical 20.4 compositions/s and 81 maintenance passes/s. This single
pair supports animation as an idle cost, not an explanation of the streaming
gap. Status indicators and output still update with intensity zero.
Raw: `dist/telemetry-{minimal,no-animation}-node1-long/`.

Per-thread CPU separates work that main-thread spans/profiles cannot see. In
the telemetry-disabled longer streaming run:

| Thread category | Daemon CPU | Viewer CPU |
| --- | ---: | ---: |
| Main thread | 8.92% | 5.58% |
| JIT workers | 1.47% | 0.66% |
| Heap helpers + allocator scavenger | 0.91% | 0.86% |
| Native file-descriptor readiness | 0.96% | — |
| Resource sampling worker | 0.71% | — |
| Authoritative whole-process total | 13.25% | 7.10% |

Other small threads and slightly different observation boundaries account for
the remaining difference. Per-thread windows use inner half-second samples and
exclude threads absent at an endpoint. Heap/scavenger CPU does not establish
allocation volume, and JIT is partly transient: first-to-last ten-second buckets
fell from 2.39 to 0.62% in the daemon and 0.94 to 0.42% in the viewer. The short
benchmark must not be described as fully settled compilation.

A followup warms continuous output for **120 seconds**, then measures **60
seconds**. Corgi still uses **11.37% daemon + 7.05% viewer**. Main-thread CPU
averages 8.33% and 5.37%, staying within 8.12–8.67% and 5.21–5.63% across ten-second
buckets. JIT declines toward 0.21% in both processes’ last bucket; it is not
assumed to be permanently zero. Recovery history also changes during warmup,
so the whole reduction cannot be attributed to compilation alone. Herdr was
not rerun with this longer window; this is a Corgi settling diagnostic, not a
new matched ranking. Raw: `dist/telemetry-steady-stream-node1/`.

Turning aggregate telemetry on changed attached-streaming total from 20.35%
to 20.45% in this pair. Other phases moved between −0.30 and +0.30 points.
That is no resolved whole-app slowdown at this experiment’s precision, **not**
a ±0.30-point overhead guarantee. The hot-loop span costs below are cleaner
measurements of the recording mechanism itself.

## Mechanisms and compact equivalents

| Component | Current mechanism | Measured opportunity | Architectural direction |
| --- | --- | --- | --- |
| Viewer composition | Rebuild UI objects and ANSI strings, regenerate pane rows, rewrite sidebar cursor positions, reconcile navigation repeatedly | Streaming profile: 38.5% of main-thread samples in composition; sidebar coordinate rewriting alone 7% | Retain pane/sidebar output by explicit revisions; emit coordinates at their final origin; reconcile navigation when models change |
| Pane transport/mirror | Native surface → JSON → JS tree → JSON → wire → JS tree → JSON → native parse → full ANSI replay | Export 173.9→117.3 µs; eager receive/rows 181.1→4.1 µs for scrolling 132×47 | Opaque surface ownership; lazy native mirror for operations that actually need it; avoid converting already valid rows back into a terminal |
| Final presentation | Compose complete frame; feed host differ’s emulator; scan cells and emit changed spans | 217.4→6.5 µs with row differ, but **10.9× more output bytes** | Retain dirty regions while preserving existing cell-span precision; do not substitute this row prototype wholesale |
| Git branch/push state | Five Git subprocesses per unchanged linked workspace every three seconds | Sixteen workspaces: 192.6→2.52 ms CPU/sweep, including children; 6.42→0.084% core at cadence | Resolve worktree/common git directories once; invalidate from relevant metadata with bounded fallback refresh |
| Unchanged transcript observations | Poll returns historical facts again; each result marks visible and durable state changed | Eight Claude tails: 32 results/s, zero ingestion during windows; idle recovery becomes active | Compare semantic deltas; separate freshness, fact, display and durable revisions |
| Resource sampler transfer | Persistent worker receives/restores prior history every sample, then returns full next state | One workspace/16 processes: 1.16→0.54 ms; eight workspaces/8 processes: 8.84→4.00 ms | Keep sampler state in its existing worker; send roots/options, preserve restart/handoff contract |
| Agent snapshots | Construct defaults and UTF-8 round-trip immutable bounded strings | Sixteen snapshots: 121.6→46.8 µs; only ~0.03 points at 4 Hz | Explicit validated-text clone, independent mutable wrappers; useful cleanup, low priority alone |
| Screen-tail parsing | Split all visible rows to retain the final eight | Normal 48-row screen: 2.66→0.88 µs | Bounded tail scan; native row-range extraction matters more than this tiny JS saving |
| Codex session polling | Full sequential RPC reads to extract a few signals, including repeated history search | Normal fixture 109 KB/5 RPC; no-location 3,000-item fixture 3.31 MB/34 RPC and 6.57 ms CPU/pass | Provider revisions/deltas or cache with complete invalidation; do not infer child/background state from a coarse timestamp |

These are separate experiments, not additive product savings. Git’s cost scales
with tracked workspaces; merely having sixteen directories elsewhere does not
incur it. Codex fixture CPU includes synthetic server serialization and client
parsing, excludes sockets/provider work, and is not a real-session latency.
Its worker permits one pass per account, so a slow pass cannot be extrapolated
as an unconditional 2 Hz rate.

A resource-host hypothesis was also tested and rejected. On the clean second
NUMA node, production `resource_os.host()` cost **514 µs CPU/sample**, of which
`os.cpus().length` cost **52 µs**, `/proc/stat` reads **414 µs**, and memory pressure
reads **33 µs** in separate mechanical tests. Reusing `/proc/stat` to count online
CPUs reduced the full call to **462 µs**, only **0.0026 core points** projected at
0.5 Hz. This does not explain the resource worker’s 0.66–0.72% CPU. The first-node
run had 56% sibling activity and is rejected for causal comparison; the clean
second-node run agreed. These are warm repeated calls; runtime caching after
idle gaps is not established by that microbenchmark.

Additional in-application spans locate the resource cost. With sixteen agents,
two host NVIDIA devices, the ordinary two-second sampling interval and ten
completed samples:

| Resource stage | Mean elapsed ms/sample | Share of sample body |
| --- | ---: | ---: |
| GPU read and attribution | 6.430 | 49.4% |
| Owned process/task inventory and counters | 4.876 | 37.5% |
| Host counters | 1.284 | 9.9% |
| Remaining construction/aggregation | 0.424 | 3.3% |
| Sample body total | 13.014 | 100% |

The worker used **0.78% CPU** in this separate run. Its stage durations include
blocking/descheduling and are not individual CPU measurements. Real-cadence
host cost exceeds its hot-loop microbenchmark, illustrating why those models
are not macro bounds. Linux inventory walks owned processes’ task/children files
and reads per-PID stat/I/O. GPU sampling calls NVML for host devices and their
process/memory/utilization data even without a GPU workload from these agents.
Moving these operations to Zig retains those driver/filesystem costs. Changing
sampling demand/cadence or narrowing required device data requires an explicit
freshness/feature decision; it is not an established equivalent optimization.
Raw: `dist/telemetry-resources-final/`, using the final instrumented binary with
three additional resource spans. The prior comparison binary remains frozen.

The snapshot, screen-tail, resource-transfer and Git prototypes include output
or mutation-equivalence checks. Terminal prototypes passed 322 frames, including
cursor/modes and lazy fallback for dimming, hyperlinks and selection. They
establish specific mechanical opportunities, not complete replacement systems.
The Git prototype still needs included-config, reftable, submodule, replacement
and concurrent-change handling. Retained resources need ownership/restart tests.

Codex additionally needs an observation heartbeat: protocol authority expires after
five seconds without freshness. A cache that suppresses identical facts must
refresh freshness without unnecessarily changing visible or durable state.

Details: [terminal representations](terminal_findings.md),
[observations and workspace services](observation_findings.md).

## Recovery has a buffer threshold and unnecessary triggers

Normal recovery formats terminal history, JSON-encodes it in Zig, decodes it in
Bun, creates a UTF-8 Buffer, copies that Buffer again for base64, then serializes
and atomically writes the checkpoint. `native_bridge.call` starts each reply
with 65,536 bytes; an oversized reply reruns the native operation after allocating
a bigger buffer. For snapshots this repeats formatting and native serialization.
The larger buffer is then discarded.

At 512 generated lines per pane in the sixteen-pane fixture, every reply crossed
that threshold: **32 native calls/save**, versus sixteen when reply capacity
was retained. Current CPU was **12.482 ms/save → 7.015 ms** with retained capacity,
or **6.833 ms** including simpler parsing/direct base64. Capacity alone projects
**0.273 core percentage points** at one save every two seconds. All 68 checked
terminal fixtures preserved exact snapshot and stored base64 bytes.

At 4,096 lines, page-granular history pruning left only one oversized reply and
the saving fell to about 0.026 points. The configured scrollback budget is not
a hard formatted-output byte cap. Stream age and pruning change cost sharply;
do not assume either a constant or monotonic cost per pane. This microbenchmark
excludes checkpoint JSON and filesystem work.

The unchanged-observation experiment independently shows why avoiding the save
can matter more than accelerating serialization. Rich history emitted 640
unchanged usage results per 20-second phase, zero ingested records, and nine idle
recovery saves where minimal history emitted none. After streaming, these saves
averaged about **54 ms elapsed**, including filesystem waits. Session payloads
were still suppressed by their unchanged hashes. Rich history also changes
actual UI metadata, so its whole-process CPU delta is not an isolated estimate
of an EOF-deduplication fix.

Recovery also snapshots archived closed panes, up to eight per workspace. Current
close paths stop their PTY/watch; they are candidates for cached recovery bytes.
Use identity/revision validity, rather than assuming an externally mutable
Terminal object can never change. Closed-pane savings are not measured here.
The 16 MiB `liveSnapshot` buffer belongs to handoff; it is **not** the periodic
recovery path and is not charged to these measurements.

## Data movement, allocation and scaling

A roughly 132-byte program update becomes an average 8,910-byte surface JSON
message in the scrolling fixture, about 67× expansion. In the diagnostic app
run the viewer received about 183 KB/s but built roughly 0.52 MB/s of UTF-8-equivalent composed
frame data. It also converts those strings to bytes for the native host
differ. Normal rows cross back from native through a freshly allocated Buffer
and UTF-8 string. These materializations are supported by counters and source;
they do not measure the allocator’s complete traffic.

```mermaid
flowchart LR
  A[PTY bytes] --> B[Daemon Ghostty terminal]
  B -->|full surface JSON| C[Bun object tree]
  C -->|JSON socket message| D[Viewer object tree]
  D -->|JSON and ANSI replay| E[Viewer Ghostty mirror]
  E -->|rows as ANSI strings| F[Compose full UI frame]
  F -->|UTF-8 and full replay| G[Native host differ]
  G -->|changed cell spans| H[Outer terminal]
```

The lower-level native receive/render cost was 158.2 µs/update. Replaying an
already assembled ANSI frame still cost 123.7 µs. Parsing the original program
update cost 0.37 µs. Merely replacing JSON with a binary codec therefore leaves
most of the replay work. The proposed native boundary should expose retained
screen/surface handles, revisions and row-range operations; it should keep
provider policy and UI choices in TypeScript.

Cheap native control operations also deserve a narrower boundary. The streaming
run made about 1,164 generic native calls/s, including 319 ticks and 116 info
reads. Readiness callbacks also flush pending output, and collection checks for
copied clipboard data. Existing `terminal_pending` is already a direct scalar
FFI call. Returning dirty/pending/copied flags from one typed tick, and only
fetching payloads when needed, could reduce per-call JSON and allocation. This
is a source-backed candidate, not a measured saving; the `native.other` timer
also contains expensive snapshots and cannot be charged wholesale to cheap
control calls. The readiness thread itself used roughly 0.6–1.0% CPU, a separate
budget from the ~0.10% elapsed input-feed span.

The work scales along different axes:

- Terminal input/emulation: bytes, terminal operations, total active panes and
  their screen/scrollback sizes. Hidden panes still need their terminal state.
- Surface export and viewer mirror: visible panes × updated screen area ×
  viewers × update cadence. A one-cell update currently revisits whole frames.
- UI composition: viewer area, agent/sidebar entries and animation cadence.
  Navigation reconciliation includes repeated copying and quadratic tab lookup.
- Observation: followed sessions, process descendants, due screens and newly
  appended transcript bytes. Polling unchanged histories adds a separate cost.
- Workspace services: tracked workspaces, repositories, processes, histories,
  changed files, and whether detail panels are open.

The assumed normal terminal scene here is sixteen agents plus a quiet shell,
one visible pane, 160×48 outer terminal, and twenty approximately 130-byte lines
per agent per second. Default hidden Corgi panes stay 80×24; the matched-geometry
followup corrects that difference. No claim is made for many viewers, image
protocols, huge scrollback, dense editor redraws or real model/tool activity.

## Telemetry and attribution

[telemetry.ts](../../src/telemetry.ts) adds opt-in fixed-name counters, elapsed
spans and byte counts. Default-off checks had no measurable incremental cost in the hot loop;
that is not a claim of zero whole-program overhead. Enabled aggregation cost a median **85 ns per timed span**; the
bounded timeline cost **92 ns**. Timed spans write typed arrays, allocate no
per-event objects, and perform no I/O. The optional 65,536-event ring takes
1.5 MiB per participating thread and overwrites old events. Dumps report loss.

Set `CORGI_TELEMETRY_DIR` to enable aggregation; add
`CORGI_TELEMETRY_TRACE=1` for Chrome/Perfetto timeline events. Send SIGUSR2 to
an instrumented daemon/viewer to dump outside a measurement window. The daemon
also requests the resource worker’s dump. Normal exit dumps best-effort.
Trace export allocates objects and can disturb subsequent measurements; use
aggregate-only timing and a separate trace run. Worker `cpuUsage` is
process-wide and must not be summed with the main thread’s.

`cpu.ts` supports `CPU_TELEMETRY=1`; `telemetry_summary.py OUTPUT` derives
per-phase rates and an optional `timeline.json`. `cost_probe.py` separately
samples per-thread CPU/RSS and sibling load at 500 ms. **Elapsed spans overlap
and include waits/descheduling. They cannot be added as CPU percentages.**
Bun CPU profiles include sleep-sized sample gaps, so the profile analysis counts
phase-filtered stack samples rather than charging each gap to its stack.

A streaming diagnostic had about 20 surface updates/s but 23–26 UI compositions/s
and roughly 81 viewer-maintenance passes/s. Idle composition remained around
9/s despite only 2–4 presentations/s. Native calls were roughly 1,160/s across
sixteen agents. About 319 feeds/s caused 637 drain invocations/s: the readiness
callback drains, and the later terminal tick drains again. This is evidence of
repeated drain attempts, **not** evidence of two kernel data chunks per line.

The minute-long streaming run gives this operating budget. Values below are
**elapsed time inside the named span**, not CPU attribution; nested rows must
not be summed:

| Span | Calls/s | Elapsed ms per wall second | Scope |
| --- | ---: | ---: | --- |
| Feed terminal bytes | 319.2 | 0.99 | Synchronous native input parser; 42.8 KB/s across all agents |
| Observe agents | 20.0 | 14.55 | Inclusive foreground/detection/tail scheduling |
| Capture visible screen text | 63.7 | 2.28 | Nested in detection; 117.8 KB/s of text |
| Capture visible surface | 20.0 | 8.00 | Includes native JSON and Bun decode; 178 KB/s reply data |
| Recovery save | 0.48 | 18.19 | Includes snapshot construction and filesystem waits |
| Resource sample body | 0.50 | 5.98 | Worker; excludes its message transfer/restoration |
| Viewer surface installation | 20.0 | 8.35 | Includes native mirror receive |
| Compose UI | 20.5 | 14.18 | Full frame strings; 458 KB/s |
| Present UI | 20.5 | 13.93 | Native final differ and writes |
| Viewer maintenance | 80.5 | 1.80 | Small but frequent local passes |

This shows why optimizing the original PTY byte parser alone has little room
in this workload. Native work already handles that parser; expensive repeated
representations and scheduling around it remain in both languages.

The separate `dist/telemetry-timeline/timeline.json` can be loaded into a Chrome
trace viewer or Perfetto. At roughly 6,000 recorded spans/s, the daemon’s ring
holds about eleven seconds, so this run uses eight-second phases and dumps
after each. Older lifetime events are overwritten deliberately. Aggregate
counters remain complete; the timeline reports bounded retained history.

The diagnostics cover terminal, observer, usage, provider, Git/worktree/ports,
resource-worker, recovery, sync, composition, and presentation boundaries.
Inference/model calls, opened worktree details, actual bound Codex polling and
account refreshes were not exercised by the terminal fixture; their trigger
and scaling inventory is in the observation report. The resource meter is a
Corgi feature absent from the inspected Herdr version, so the default comparison
includes a deliberate product difference.

## Measurement discipline and limits

AMD EPYC 7C13, two sockets, 256 logical CPUs. Node-0 placements use CPUs 8–15
and memory node 0; node-1 placements use CPUs 72–79 and memory node 1. SMT
siblings are monitored and the observer stays outside the selected cores and
siblings. A global `flock` serializes team benchmarks; builds/tests also wait
for the slot. Other users’ work is not killed or moved. A 10% whole-trial sibling
load guard rejects noisy macro comparisons, while raw half-second spikes remain
visible. This is controlled placement on a shared host, not physical isolation.

The baseline matrix uses 20 seconds initial warmup, five seconds between later
phases and 15-second windows. Longer diagnostics explicitly investigate JIT
warmup. All startup/setup/build/download time is outside the windows; no startup
latency or VRAM benchmark is claimed. No GPU compute workload is generated; Corgi’s background NVML sampling is
included in the resource cost.

Profiles, microbenchmarks and instrumented runs are separate from the frozen
baseline ranking. Raw output is retained under ignored `dist/` directories,
with binary/source hashes and fixture provenance. The node-0 minimal telemetry
trial exceeded the sibling guard (13.1%) and is retained for counts/mechanism
inspection, not a causal CPU comparison. RSS/heap-thread activity does not by
itself establish an allocation rate. The kernel rejected hardware counters (`perf_event_paranoid=4`). Allocation-stack
sampling remains unmeasured; neither is fabricated from wall spans.

## Implementation order suggested by the evidence

1. Separate observation freshness from semantic/display/durable changes. Stop
   unchanged EOF facts from causing recovery and reconstruction, while keeping
   the existing expiry, completion and authority rules. Measure both quiet and
   active real sessions; the fake terminal fixture alone misses this cost.
2. Give linked workspaces the same kind of metadata-based fast path as main
   checkouts, with full config/ref/lifecycle invalidation. This has the largest
   demonstrated micro-to-cadence opportunity in the tested workspace scene.
3. Retain native reply capacity with an explicit memory cap and cache unchanged
   recovery bytes, especially closed panes. This is smaller than the first two
   but has an exact, measured threshold mechanism and can be isolated cleanly.
4. Make rendering consume explicit damage/revisions through composition and
   presentation. Preserve cell-span output, cursor/mode/image semantics and
   transforms. The row-only prototype’s bandwidth regression is a reason to
   keep the existing precise differ, not to copy that prototype into production.
5. Narrow remaining boundaries: lazy opaque surfaces, bounded row extraction,
   persistent resource-worker ownership, and provider revision/delta reads.
   Avoid investing first in tiny text-copy wins while full-state work persists.

This is an ordered set of implementation candidates, not a sum of promised CPU
savings. The first production optimization should keep this harness and quality
guards, compare equivalent displayed state, and include a settled streaming
window as well as the ordinary short-lived/idle scenarios.

## Implementation and validation

The production changes are telemetry only. Compact alternatives live in
benchmark tools. Native interfaces, public wire/viewer versions, checkpoints
and handoff formats are unchanged; no migration is needed. The internal resource
worker accepts an additional opt-in dump control message. A browser no-op shim
preserves the landing page’s source imports.

Validation: full `bun test src` (1,790 passed, one skipped), typecheck/format,
production and test builds against the unchanged pinned native library, benchmark
unit tests, and integration suites `links`, `reloads`, `resources`, `selection`,
`smoke_terminal`, `viewer_sync`, `viewers`. The resource suite was rerun after
the final resource spans, and the landing-page build passed with the browser
shim. Its pinned Happy DOM tooling needed a complete local installation because
the shared Bun cache lacked a transitive dependency; no dependency declarations
were changed. Separate smoke runs verify telemetry
flushes, worker participation, actual PTY geometry and output cadence.

The final source overlay, patch and SHA-256 manifest are retained as
[`investigation-source.tar.gz`](../../dist/investigation-source.tar.gz),
[`investigation.patch`](../../dist/investigation.patch), and
[`investigation-provenance.json`](../../dist/investigation-provenance.json).
The manifest distinguishes the immutable PR baseline, the main diagnostic binary,
and the final binary with finer resource spans. Raw evidence remains in `dist/`;
these generated artifacts are local and ignored by Git.
