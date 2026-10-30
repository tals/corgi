# Retained-surface validation

## Rebased on main

The effort is now rebased onto main `8153137`. The [post-rebase CPU matrix](main_rebase_matrix.md)
covers 4/8/32/64 agents, idle/streaming and attached/detached, with all cells
accepted under the original strict noise limits. The final 64-agent streaming
case uses a different NUMA node after repeated contention; the report records
that comparison limit and separates waited-child CPU. This is absolute
workload characterization, not a new Herdr comparison.

## V18 before the main rebase

V18 combines the conservative 75 ms ordinary-view wait cap with eviction of
hidden native mirror surfaces. Its prospective V15 → V18 → V18 → V15 aligned
block passed all four trials on their first attempts. Mean combined CPU is
5.983% → 6.008% of one core: no established whole-product CPU improvement.
Viewer CPU is 1.792% → 1.717%, while viewer PSS is consistently lower,
67.87 MiB → 59.80 MiB (−8.07 MiB, −11.9%). These results concern the combined
candidate; they do not isolate the wait cap or establish a new Herdr ratio.

Before/after calibration flagged drift: SHA-256 throughput increased
1.30–13.03%, with five of eight selected cores exceeding the predeclared 10%
flag. This is a review flag, not a CPU normalization or automatic rejection.
The small CPU differences remain tentative. All trials retained default
animation/resources, 16 aligned 20 Hz providers, 132×47 panes, 120 seconds
streaming warmup and 60 seconds sampled. A separate host-only pilot selected
node 0 CPUs 24–31 before application measurements. Both whole-trial and
measured-window sibling load stayed below 2%; exact writes, pane/animation
progress, executable/native identity and cleanup checks passed.

V18 passed 1,940 unit tests with one skip, 50 focused tests, format/typecheck
and production/test/browser builds. All seven integration suites now pass
(109 cases, two platform skips). The first selection run failed because a
resource reading appeared in the sidebar between whole-frame comparisons;
the selected pane itself was unchanged. The unchanged suite passed its serial
rerun. Both logs are retained as `dist/retained-v18-integration-attempt1.log`
and `dist/retained-v18-selection-attempt2.log`.

All nineteen screenshot states match PR15 exactly in styled cells, links,
cursor, image placements/pixels and PNG hashes (`dist/retained-visual-v18/`).
Selection while output arrives, dimmed dialogs and split panes were also
visually inspected. Frozen source and binary provenance are in
`dist/retained-v18-source.json`; raw CPU/memory evidence is in
`dist/retained-v18-v15-aligned/`. See `viewer_heartbeat_findings.md` for ranges,
thread accounting and the earlier V17-only block that stopped after three
rejected baseline attempts without measuring V17.

## V18 agent-count comparison

The completed [agent-count matrix](agent_scale_findings.md) covers idle/busy,
attached/detached and 4/8/32 providers against the pinned Herdr binary. It uses
30-second warmups and 60-second samples, separately from the earlier 16-agent
runs. Fourteen process observations passed the strict noise checks; ten are
explicitly flagged approximate readings. All workload and provenance checks
passed. At 32 busy agents, observed process CPU is 8.35% versus 6.05% attached
and 5.37% versus 5.57% detached. The attached Corgi run also records 0.70 points
of waited-child CPU, whose accounting and timing limitation are documented in
the matrix report. These noisy observations do not establish precise parity.

## Earlier controlled 16-agent Herdr evidence: v15

Production was restored to V15 before preparing V17/V18, after rejecting V16's
native PTY reader. The completed phase-controlled V15 observations are 6.083% total CPU
versus Herdr 3.617% with aligned writers, and 6.633% versus 3.817% with staggered
writers (1.68× and 1.74×). These are single accepted pairs per phase, with default
Corgi animation/resources enabled; they do not establish parity or confidence
intervals. See `producer_phase_findings.md` for guards, rejected attempts and
raw receipts. This supersedes the older uncontrolled-phase comparison below
for current product comparison.

V16 passed 60 native tests, 1,946 unit tests, all seven integration suites and
all nineteen settled screenshot states, but its reader moved main-thread CPU
into native worker CPU without a meaningful whole-product improvement. Its
source, binaries, native assets, all raw measurements and failed checks remain
archived. `dist/retained-v16-rejection-restoration.json` records restoration of
all 27 V16-specific source changes and the V15 native assets, with the complete
V15 source overlay verified. See `pty_reader_findings.md` for the rejection.

A benchmark-only row-delta wire prototype passes equivalence checks and removes
about 92% of sparse surface bytes. Its pooled combined CPU medians are
188.53→151.25 µs/update; at 20 Hz that models only 0.075 percentage points of
one core before real sockets/capture. Scrolling regresses 7.1%. It is not adopted:
these results do not justify a protocol change by themselves. Raw measurements
and the scope exclusions are under `dist/surface-delta-v16/` and
`surface_delta_design.md`.

The latest balanced Herdr comparison is v11's sparse-update block: Corgi
7.008% of one core (daemon 5.083%, viewer 1.925%) versus Herdr 3.317%
(3.100%, 0.217%), or **2.11×**. This exploratory block uses C→H→H→C
order, matched inner PTYs, all-thread utilization clamps, and the same
visible-progress guards. Corgi keeps default animation and resources enabled.
Producer phases were not controlled: each simulated agent started its own
interval after a product-specific startup command. The ratio describes that
observed block, not a phase-controlled comparison or a comparability result.
See `producer_phase_findings.md`. Raw receipts are in
`dist/retained-v11-herdr-sparse-block1/`.

V12 passes 1,915 unit tests with one skip, 109 integration cases with two
platform skips, typecheck/format and production/test/browser builds. All
nineteen screenshot states match PR15 in styled cells, links, cursor, images
and rendered PNG hashes on the first run (`dist/retained-visual-v12/`).
Its frozen binary is `dist/corgi-retained-v12`, SHA-256
`e4d542b3008ba3f2c38f48ad833ac76f6dc448fb3fcc8a2252a41af4a63c4a8b`;
source/native receipts are `dist/retained-v12-source.json`.

V12 owns agent comparison values without serializing them, retains unchanged
launcher previews, computes pane geometry from scalar inputs, refreshes
retained frames once, and skips unnecessary foreground queries during CWD
refresh. On both NUMA nodes, agent comparison costs 79–81% less CPU and a
stable launcher publication with no extra accounts costs 80–81% less CPU.
The latter projects only about 0.09 percentage points of one core at 10 Hz;
component savings are not whole-application savings. A native CWD wrapper
was measured and rejected: normal successful lookups saved only 0.1–0.3 µs,
insufficient to justify another boundary and fallback implementation.

A single accepted v12 sparse trial measures daemon 4.717%, viewer 1.717%,
total 6.433%. This is directional evidence against v11's 7.008% mean,
not a new paired Herdr comparison. Its first attempt failed the predeclared
SMT-noise guard; both attempts are retained in
`dist/retained-v12-sparse-single/`. Pane progress is 20.002 updates/s and
sidebar animation 12.668 changes/s. Further optimization and repeated
balanced comparisons remain necessary.

V13b adds direct fresh process-group membership, synchronous fast paths for
idle clipboard/controller maintenance, scalar terminal-size comparison, and
batched readiness notifications. It passes 1,927 unit tests with one skip,
52 native tests, typecheck/format, production/test/browser builds, all seven
integration suites (109 passing cases, two platform skips), and all nineteen
PR15 screenshot comparisons. Provenance is `dist/retained-v13b-source.json`;
the binary SHA-256 is
`760e8623f1abd7243bd3038094e51f47aad2db84e5fe03d74889268fc6f3b103`.
No v13b whole-application performance claim has been established yet.

The initial v13 candidate cached terminal dimensions until a signal. Two
integration tests exposed supported PTY resizes that did not reliably send
SIGWINCH. V13b restores per-loop size reads; clipboard behavior was already
correct, and the same two tests pass after only that reversion. The original
v13 binaries, source and failed logs remain archived unchanged.

Process-group membership now uses getpgid instead of reading and decoding
the entire `/proc/PID/stat` record. Successful fresh lookups cost roughly
11–13 µs before and 0.23 µs after, about 98% less in isolated measurements
on both NUMA nodes. This does not cache PID identity, argv, or group membership.

Readiness batching sends the kernel's existing ordered event batch in one
write. A controlled aligned-writer micro measures native-thread CPU falling
0.1098%→0.0598% of one core; staggered writers remain effectively unchanged
(0.6887%→0.6877%). The aligned diagnostic sends 1,280 records in 130 sends
instead of 1,280, but Bun data callbacks barely change: fewer sends do not
imply the same reduction in event-loop wakeups. These are transport component
results, not daemon savings. See `dist/readiness-v13b-node0/`.

A subsequent NVML buffer-reuse prototype removed two preliminary queries per
sample, but real driver-read CPU changed in opposite directions on the two
nodes. Required utilization data calls accounted for 92–96% of traced driver
wall time. The prototype is rejected despite faster synthetic cases; raw
results are retained under `dist/retained-v14-nvml-node{0,1}/`.

The v14 surface change carries only identity/revision as decimal
strings across native JSON, uses plain JSON parsing for that operation, then
normalizes those receipts back to BigInt before wire encoding. Other native
operations retain the generic decoder. V14 passes 53 native tests, 1,931 unit
tests with one skip, format/typecheck, production/test/browser builds, and all
seven integration suites (109 passing cases, two platform skips). Its unchanged
visual repeat matches all nineteen states and PNG hashes against PR15. The
first visual run is preserved: asynchronous baseline process discovery had not
yet updated eight title cells and one process icon in the second screen.
All 1,464 component equivalence checks across verification and timing runs
pass, including identical normalized wire bytes.

V14 provenance is `dist/retained-v14-source.json`; production binary SHA-256
is `b1cedd6fd495d346f8ece88d52df886b6b958e5d3f0f8b065dc32f444b5bfd97`.
Screenshot proof is under `dist/retained-visual-v14-retry1/`; the first run's
detailed mismatch is `dist/retained-visual-v14/first-run-mismatch.json`.
The first v14 sparse trial passes all existing guards and measures daemon
4.900%, viewer 1.767%, total 6.667% of one core. This single trial does not
establish an improvement over the earlier v12 single trial's 6.433%, and is
not a new paired Herdr comparison. The added per-thread user/system counters
identify daemon main-thread CPU of 3.048% (1.835% user, 1.212% system),
readiness-thread CPU of 0.539% (0.051% user, 0.488% system), resource-worker
CPU of 0.522% (0.101% user, 0.421% system), and viewer main-thread CPU of
1.313% (1.010% user, 0.303% system). These are actual process-accounting
splits, not allocations of overlapping telemetry spans. All 12,712 recorded
accounting identities pass. Receipts and raw hashes are under
`dist/retained-v14-sparse-single/`.

One accepted node-0 component run measures feed/capture/decode/wire CPU of
63.68→47.60 µs for unchanged frames, 83.05→71.35 µs for sparse updates and
165.56→154.95 µs for scrolling. Autolinks regress 247.96→252.71 µs.
Both node-1 attempts exceed the sibling-noise guard and are excluded. Ordinary
capture savings project to only about 0.02–0.03 percentage points of one core
at 20 updates/s; this is not a macro result or a two-node confirmation.
Raw results and frozen inputs: `dist/surface-json-summary.json` and
`dist/surface-json-inputs/manifest.json`.

A separate launch-traced v14 diagnostic counts about 2,961 daemon main-thread
syscalls/s: 318 PTY data reads and 318 EAGAIN results, 125 command-line data
reads and 125 EOF results, 325 CWD readlinks, and 340 readiness rearm calls.
The PTY reporter sends 318 notifications/s in 276 batches/s; 90.5% of its
batches contain a single event. The viewer queries dimensions 89.5 times/s
while writing 32.3 frames/s. Tracing perturbs execution, so these counts
explain paths rather than rank their CPU cost. Raw evidence and provenance:
`dist/retained-v14-strace/findings.md`.

V15 feeds frame-status answers
into the parser immediately but wakes the main loop only if a frame or exit
is waiting for the answer. Answers carrying input still wake it. Per-loop
dimension queries remain intact. The optional `viewer.pacer.quiet_answer`
counter measures suppressed wakes. V15 passes 1,931 unit tests with one skip,
typecheck/format, production/test/browser builds, and all seven integration
suites (109 cases, two platform skips), including slow-host frame holding,
PTY resizes, reloads and terminal restoration. Its native assets are identical
to the v14 assets whose 53 native tests passed. All nineteen PR15 screenshot
states match on the first run in styled cells, cursor, links, image pixels and
PNG hashes. The split-pane, held-selection and dimmed-dialog comparison images
were also inspected visually.

The subsequent default-feature V14/V15 ABBA block passes all four trials on
their first attempts. It does not demonstrate a viewer improvement: viewer
means are 1.675% and 1.667% of one core, with overlapping ranges. Combined
means are 6.175% and 6.625%; daemon means are 4.500% and 4.958% despite unchanged
daemon source. Producer relative phases were uncontrolled, so that difference
has no established causal explanation. Every trial remains accepted under its
original guards. The next product comparison needs the shared producer clock
described above. Full accounting and provenance are in
`dist/retained-v15-v14-sparse-node0/` and `viewer_pacing_findings.md`.

V15 binary SHA-256 is
`16e511eb3bfda49837cf7b17406dac2375a4bab66a25f3fc0438cfbccdf5a31a`;
`dist/retained-v15-source.json` verifies that only `src/viewer.ts` and
`src/telemetry.ts` differ from v14's product source. Screenshots are under
`dist/retained-visual-v15/`; the complete validation logs have prefix
`dist/retained-v15-`.

The separate v14 feature-attribution block is incomplete: its final default
repeat exhausted all three predeclared attempts on external CPU noise. The
accepted first default trial is 6.567% total CPU, and two trials with resources
disabled and decoration intensity zero are 5.083% and 5.167%. Both settings
retain the informative working spinners and pass the same progress guard.
These observations do not establish a balanced effect estimate or parity with
Herdr. The resource worker accounts for about 0.52 percentage points in the
default trial and is absent in both quiet trials. Full receipts, rejected runs
and limits are in `feature_findings.md` and
`dist/retained-v14-feature-attribution/`.

## Earlier validation

Reference: frozen PR #15 binary `dist/corgi-pr15`, commit
`fb129d2ef96511a3c727112e0d1df2191bb5b241`. Each candidate has its own immutable
binary and `.build.json` with source/native hashes. Timed binaries use their
embedded native libraries: the coordinator removes `CORGI_NATIVE_ROOT`, reads
the daemon/viewer's actual `/proc/PID/maps`, hashes both loaded Corgi libraries,
and requires their extraction directory to match that binary's native hash.
The source harness loads the worktree's native library separately.

The completed PR15 comparison below uses `dist/corgi-retained-v6`, SHA-256
`23155a52eb7d4d5c766b9baf794d22afbf6f242f7c5f6a2fc7530269248de560`.
On the sparse-update workload, viewer CPU falls **33.3%** and combined
daemon/viewer CPU falls **11.4%** across paired NUMA placements. Scrolling gains
are smaller: the preceding v5 experiment reduces viewer CPU 11.8%, with a
variable 4.0% combined reduction. These results do not imply the same saving
for every workload. All nineteen final-candidate screenshots match the baseline.

Final checks: the full source/tool suite passes 1,844 tests with one skip;
thirteen native tests pass; typecheck/format and production/test/browser builds
pass. All seven requested integration suites pass: `links`, `reloads`,
`resources`, `selection`, `smoke_terminal`, `viewer_sync`, and `viewers` (109
passing cases and two platform skips). `selection` required one isolated rerun:
the first attempt compared the entire UI while the resource label changed from
blank to `M 0M`; the held pane text did not change. The untouched suite then
passed all three cases. Both logs remain available, and the independent visual
fixture verifies held pane text, arriving background output and release.

Logs: `dist/retained-v6-unit-tests.log`, `dist/native-exact48-tests.log`,
`dist/retained-v6-typecheck.log`, `dist/retained-v6-build.log`,
`dist/retained-v6-test-build.log`, `dist/retained-v6-site-build.log`,
`dist/retained-v6-integration.log`, and `dist/retained-v6-selection-rerun.log`.
Build/source provenance is under `dist/corgi-retained-v6.*` and
`dist/retained-v6-source.*`; the final report/source overlay is retained
separately as `dist/retained-final-source.tar.gz` with its SHA-256 manifest.

## Continuing comparison with Herdr

The subsequent investigation compares Corgi with Herdr 0.9.5, source commit
`2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`. These are new trials with all sixteen
agent PTYs matched at 132×47, including hidden panes. Do not combine them with
the earlier PR15 trials, whose hidden panes retained their default geometry.
Each trial keeps Corgi's default animation and resources enabled, warms the
stream for 120 seconds and measures all process threads for 60 seconds.
Herdr has different chrome and no equivalent continuous sidebar animation or
resource service. Visible pane progress is checked independently.

Single fresh pairs are directional measurements, not final parity evidence:

| Workload / candidate | Corgi daemon | Corgi viewer | Corgi total | Herdr total |
| --- | ---: | ---: | ---: | ---: |
| Scrolling / v6 | 11.55% | 5.77% | 17.32% | 10.38% |
| Scrolling / v7 | 10.53% | 5.90% | 16.43% | 14.05% |
| Sparse / v7 | 8.60% | 4.98% | 13.58% | 5.93% |
| Sparse / v8 | 8.95% | 4.35% | 13.30% | 5.97% |

CPU is percent of one core. V8 is still **2.23 times Herdr's combined CPU** in
the sparse pair; its viewer alone is 12.43 times Herdr's 0.35%. This is not
parity. V8 preserves 20.00 visible pane updates/s and 12.67 sidebar spinner
changes/s. Geometry, executable/native provenance, cleanup and sibling-noise
guards passed. Raw data: `dist/retained-v{6,7,8}-herdr-*`.

Herdr's scrolling CPU varied substantially between the first two pairs. The
host uses adaptive frequencies; later observers record per-core reported
frequency, process placement and host population alongside CPU. The v8 sparse
pair's busy-weighted reported values were close (1.546 and 1.544 GHz). These
are diagnostic observations, not effective cycle measurements; results are
not normalized by them. Final comparisons still need repeated order and NUMA
placements.

V7 removes routine tick/flush/empty-clipboard JSON, sends recovery bytes directly
to base64 encoding, and emits sidebar coordinates at their final origin. A
separate scrolling diagnostic measures native JSON calls falling from about
1,156/s to 180/s and recovery elapsed span time falling by about 47%. Those
spans overlap other work and are not additive process CPU savings. V8 retains
static frame metadata and patches the complete sidebar at its existing deadline.
Its sparse viewer improvement over the preceding single v7 trial is 12.7%;
combined CPU improves only 2.1%, with daemon variance.

V8 is frozen as `dist/corgi-retained-v8` with SHA-256
`35d2e174a04e4fe3e464391279e2f8deda82e254f5417c4df9d2c116887f47a6`.
Its source archive and hashes are `dist/retained-v8-source.{tar.gz,json}`.
Validation: 1,874 source/tool tests pass, one skips; all sixteen native tests
and typecheck/format pass. The newer candidate's integration and screenshot
validation remain pending; the nineteen screenshots below substantiate v6.

V9 adds explicit retained sidebar detail rows, a lazy native cache of canonical
pane row bytes and direct UTF-8 screen-text transfer. It is frozen as
`dist/corgi-retained-v9`, SHA-256
`8df78d85604b059b9944cf84c6a0c7eca4b29fd75e3670d53184ae415d038bd8`;
source/native hashes are in `dist/retained-v9-source.json`. Its measured component
results are described below. Full surfaces and their owned snapshot lifetime remain
the reference; caching producer row formatting does not itself eliminate wire
JSON or per-frame row copies. The component verification observes 86 formatted
rows over forty sparse frames (47 initially, then 39 changed), versus 1,880 for
full capture; this is a work count, not a whole-application speedup.

V9 validation passes 1,886 source/tool tests with one skip, all 51 native tests,
typecheck/format and production/test/browser builds. The seven integration
suites pass 109 cases with two platform skips on their first run. All nineteen
PR15/v9 screenshot states match in captured styled cells and rendered PNGs;
artifacts are `dist/retained-visual-v9/`. These PTY visual fixtures have a quiet
sidebar. Animation-specific checks additionally exercise deterministic clocks,
Unicode, selected/hovered/grouped rows, notes/context colors, compaction,
transitions, image boundaries, skipped frames and lazy fallback materialization.
The component harness seeds randomized awake routines identically in both
frozen source trees before checking and timing them.

V9 component measurements are repeated on both NUMA nodes with reversed method
order. Native sparse producer capture costs 73–74% less CPU than v8; capture
through JSON decode/re-encode costs about 51% less. Scrolling producer capture
is essentially unchanged, and conservative reverse-video/autolink cases retain
small 2–5% regressions. The real Controller composition harness measures about
59% less sparse-frame CPU and 31–32% less scrolling-frame CPU. Animation cases
improve 59–78%. These exclude daemon scheduling, wire transport and other
services. All 336 verification frames match full ANSI, diff output and styled
surfaces; timed output counts and bytes match too. See
`dist/component-v9-summary.json` and `herdr_findings.md` for raw paths and ranges.

The natural-clock v9 sparse run uses 8.72% daemon and 3.17% viewer CPU, 11.88%
combined, versus the preceding v8 run's 13.30%. That is directional evidence,
not an isolated treatment effect. The contemporaneous Herdr pair was rejected
under its then-declared reported-frequency gate; that rejection is retained.
Later inspection of the exact Ubuntu kernel shows `scaling_cur_freq` can mix a
recent APERF/MPERF reading with a cached requested-frequency fallback when its
sample is over 20 ms old. Half-second CPU deltas cannot align those windows.
Future comparisons therefore use reported frequency as a diagnostic, repeated
balanced application order and independent calibration; no CPU result is
normalized by reported MHz. Historical acceptance records are not rewritten.

V10 makes readiness the sole normal PTY reader, creates viewer terminal objects
and read buffers lazily, uses Bun's direct borrowed-buffer wrapper, and avoids
rebuilding an already-valid navigation selection. It passes 1,893 unit tests
with one skip, 52 native tests, typecheck/format and production/test/browser
builds. The seven integration suites pass 109 cases with two platform skips.
Its first visual run matches 18/19 screens: eight tab-title cells differ during
asynchronous process/title discovery. An unchanged retry matches all 19/19;
both runs remain in `dist/retained-visual-v10*`.

V10's first process-clamped sparse pilot observes 6.62% combined Corgi CPU and
3.60% Herdr CPU, but the pair remains excluded under its original frequency
criterion. It is neither a parity claim nor a saving relative to natural-clock
v9. Single post-window memory snapshots are 162.14 MiB combined Corgi PSS and
29.61 MiB Herdr PSS, including their runtimes and services. The lazy allocation
changes have not established a whole-process memory improvement. Raw results,
rejected attempts, clock analysis and memory receipts are preserved in
`dist/retained-v10-herdr-sparse-clamped/`.

V11 suppresses redundant readiness subscriptions with shared per-descriptor
ownership, and reads title bytes plus scalar metadata directly. It preserves
the existing title revision's session-prefix meaning: status text is always
read fresh even when that revision stays unchanged. Native title bytes are
borrowed only during a synchronous string copy; no borrowed buffer escapes.
The old JSON info operation remains an independent correctness reference.

V11 is frozen as `dist/corgi-retained-v11`, SHA-256
`5aae206130eb70a89887b6199ff19b82ac76b9cf813824138218e0d76c4c29ca`.
It passes 1,902 unit tests with one skip, 52 native tests, typecheck/format,
production/test/browser builds and all seven integration suites. Source and
native provenance are in `dist/retained-v11-source.json`; logs use the
`dist/retained-v11-` prefix. All nineteen screenshot states match PR15 in styled
cells and PNG bytes on the first run (`dist/retained-visual-v11/`). Repeated
whole-application performance validation is pending. Corgi has not yet
demonstrated comparability to Herdr.

## V6 whole-application sparse updates

The sixteen agents overwrite one row twenty times/second instead of scrolling.
All other workload settings, default animation, resource sampling, affinity,
120-second streaming warmup, 60-second CPU window and AB/BA order match the
scrolling comparison. All four trials pass native provenance, cleanup,
progress, animation and noise guards; maximum whole-run sibling load is below
1%. CPU includes every process thread, with 100% representing one core.

| Mean measurement | Frozen PR15 | V6 |
| --- | ---: | ---: |
| Viewer CPU | 7.008% | 4.675% |
| Daemon CPU | 9.525% | 9.967% |
| Combined CPU | 16.533% | 14.642% |
| Terminal output | 5,221 B/s | 5,482 B/s |
| Visible pane progress | 19.958 updates/s | 19.958 updates/s |
| Visible spinner changes | 12.501/s | 12.501/s |
| Daemon median RSS, averaged across trials | 104.37 MiB | 106.32 MiB |
| Viewer median RSS, averaged across trials | 83.34 MiB | 86.92 MiB |

Viewer CPU improves 31.8% and 34.8% in the two pairs. Combined improvements are
17.3% and 5.1%, with much greater daemon variability. Node-0 viewer main-thread
CPU falls 5.34→3.52%; auxiliary runtime work also decreases. This is an actual
application saving, distinct from the larger isolated component speedups.

Output bytes rise 5.0%, within the predefined guard. Average pane and spinner
cadence is preserved; worst sampled pane gaps are 76.46→76.52 ms and spinner
gaps 103.75→153.40 ms. Eleven spinners remain visible at stable positions.
RSS rises in this workload; reduced transient work is not a claim of lower
process memory. RSS is also not allocation traffic or uniquely owned memory.
Raw results, per-trial ranges, native hashes and rendered cadence receipts:
[`retained-v6-sparse/comparison.json`](../../dist/retained-v6-sparse/comparison.json).

## Current composition mechanism

TypeScript retains ownership of layout, animation, overlays, cursor policy and
provider interpretation. A frame contains UI ANSI, local terminal handles,
rectangles and an independent cursor. One synchronous FFI call composes all
panes; unchanged chrome needs neither allocation nor replay. Current Ghostty
cells are borrowed only inside that call. The native differ owns its previous
displayed rows, including the rare grapheme/link data whose Ghostty addresses
can change after a feed or resize.

Incoming canonical row strings are compared in the viewer before installation.
Only changed rows are erased/replayed into the retained pane; cursor and input
modes update independently. This still scans incoming row strings and still
receives the existing complete wire surface. It does not eliminate daemon
capture, wire JSON or cross-process data transfer. Row stamps are derived local
state, so no wire or saved-format migration is required.

Each native surface keeps row revisions; each differ keeps its own receipts.
Several updates before presentation accumulate, and another render consumer
cannot consume the damage. Composition compares exact semantic cells only in
damaged intervals, with no whole-cell hashes. Full replay uses the same exact
comparison backend. Small existing hashes for exceptional control and image
sequences remain. On an actual cell change, a complete owned row is copied into
reusable scratch storage before emitting precise changed spans. Compared-cell
counts therefore do not measure copied bytes or allocation traffic.

The first exact-cell layout uses 96 bytes per cell. At 160×48, the displayed
rows plus one scratch row retain 752,640 bytes, versus 122,880 bytes for the old
two hash arrays. Row/damage bookkeeping adds 10,912 bytes after a blank baseline
frame, excluding the differ object, Ghostty storage, pane receipts and managed
arenas. A receipt uses 48 bytes plus an eight-byte revision per allocated row;
all capacities are retained. This is an explicit memory tradeoff, not a claim
that owning semantic cells eliminates copying.

The compact v5 implementation reduces the common cell to 48 bytes and moves
graphemes/links behind an optional owned record. Fixed cell storage falls to
376,320 bytes (367.5 KiB). In the diverse fixture, managed arena capacity rises
from 2,352 to 22,638 bytes (22.1 KiB); both plateau across repeated cycles.
Common comparisons/copies are inlined, eliminating the initial implementation's
96-byte temporaries and out-of-line calls in each cell iteration. Sparse changes
still copy a complete changed row, now at half the common-cell width.

The UI cache is deliberately limited to one ordinary visible pane with no
pointer/overlay/selection. Its animation deadline does not slide when pane
updates arrive. Cursor movement, hiding and showing refresh scalar cursor state
without invalidating chrome. Other states retain the full renderer/fallback.
Frozen v1–v4 results below precede this damage-based backend and must not be
presented as its measurements.

## V5 component measurements

The immutable candidate is `dist/corgi-retained-v5`; its build receipt and source
overlay are `dist/corgi-retained-v5.build.json` and
`dist/retained-v5-source.{json,tar.gz}`. Its native library SHA-256 is
`f2133e4f7848c2408bab75923e99c4a544c27bf1a750fdfc3cfd0b42def173a9`.
The full TypeScript/tool suite passes 1,840 tests with one skip, and the native
executable passes thirteen tests (eleven frame tests and two imported OS tests).
Typecheck/format, full production/test builds and the landing-page build pass.
Final integration and rendered-v6 validation are recorded separately below.

Installation plus composition, process CPU microseconds per operation on node 1:

| Pane update | UI | Frozen PR15 | V5 | Reduction across both nodes |
| --- | --- | ---: | ---: | ---: |
| One changed row | Static | 499.0 | 27.6 | 94.2–94.5% |
| One changed row | Changing | 473.6 | 161.7 | 65.9–66.9% |
| Scrolling | Static | 487.4 | 257.5 | 47.2–49.6% |
| Scrolling | Changing | 501.4 | 368.5 | 24.7–26.5% |
| Diverse Unicode/color scrolling | Changing | 768.9 | 531.4 | 30.9–34.8% |

These timings exclude UI generation, producer capture, wire parsing and host
terminal output. They are not whole-application savings. Repeated unchanged
surfaces and cursor-only updates with static UI take about 4–5 µs and compare
zero cells. One-row updates compare 132 cells; scrolling compares 6,204, and
changing UI adds 1,476 exposed chrome cells. Native preparation for scrolling
with changing UI falls from 298 µs in the first exact-cell layout to 109 µs.
The initial layout's scrolling regression and rejected noisy node-0 run remain
preserved under `dist/composition-exact-*`.

Both compact runs pass exact styled-surface and output checks: 2,688 surface
checks and 896 frames compared byte-for-byte against the frozen reference.
Maximum whole-run sibling means were 7.17% and 0.79%, below the 10% rejection
threshold. Raw trials, ranges, native phase clocks, capacities and provenance:
[`composition-compact-summary.md`](../../dist/composition-compact-summary.md),
[`node 0`](../../dist/composition-compact-node0.json),
[`node 1`](../../dist/composition-compact-node1.json).

## V5 whole-application scrolling

Four fresh trials, baseline/candidate on node 0 and candidate/baseline on node 1,
used the normal sixteen-agent scrolling fixture, a 120-second streaming warmup
and a 60-second CPU sample. Every trial passed native provenance, process
cleanup, progress, animation and sibling-noise checks. All process threads are
included; 100% CPU means one core.

| Mean measurement | Frozen PR15 | V5 |
| --- | ---: | ---: |
| Viewer CPU | 7.075% | 6.242% |
| Daemon CPU | 11.717% | 11.800% |
| Combined CPU | 18.792% | 18.042% |
| Terminal output | 26,715 B/s | 13,834 B/s |
| Visible pane progress | 19.950 updates/s | 19.950 updates/s |
| Visible spinner changes | 12.501/s | 12.502/s |
| Daemon median RSS, averaged across trials | 117.51 MiB | 120.60 MiB |
| Viewer median RSS, averaged across trials | 84.54 MiB | 83.49 MiB |

Viewer CPU falls 11.8% and output bytes fall 48.2%. Combined CPU falls 4.0% on
average, but the pairs differ: node 0 changes by +0.18% (no improvement), while
node 1 improves 7.85%. This is a modest, variable combined result, not evidence
that the whole application inherited the microbenchmark's large reduction.
Node-0 thread samples show viewer main-thread CPU falling 5.04→4.47% and daemon
main-thread CPU rising 8.26→8.66%; JIT alone does not explain that pair.

Average visible cadence is preserved, with some longer observed intervals:
the worst sampled pane gap rises 52.3→76.7 ms and spinner gap 103.4→153.3 ms.
These pass the predefined absolute and relative guards; they are not a claim
of identical frame timing. Eleven visible spinners remain at stable positions.
The live viewer changes when chrome is recomposed; these byte figures describe
that complete path. The byte reduction has not been separately attributed.
Native microbenchmarks with identical frames produce identical output bytes.
Raw results and provenance are in
[`retained-v5-warm/comparison.json`](../../dist/retained-v5-warm/comparison.json).

V6 additionally keeps the visual revision stable on nonvisual SGR/input-mode
updates, while installing modes and advancing received stamps. Four regression
tests cover this, visible row/cursor changes, pending selection/viewport
invalidation and image appearance/removal. The full suite passes 1,844 tests
with one skip, plus typecheck/format and production/test builds. Its final
node-1 component recheck passes 1,344 surface checks and 448 exact-output
frames; source and binary are frozen under `dist/retained-v6-*` and
`dist/corgi-retained-v6`. The scrolling table above explicitly measures V5.

## Rendered evidence

`dist/retained-visual-v6/` contains nineteen baseline/final-candidate captures.
All nineteen match in styled cells and rendered PNG bytes. Tests compare text,
widths, foreground/background colors, bold/faint/italic/underline/strike state,
hyperlink destinations, cursor position and decoded Kitty image pixels and
placements. Only opaque image/link identifiers are excluded. The records also
retain the raw PTY output, complete cell data, plaintext, PNG hashes, and
side-by-side PNGs. Visual inspection also covered normal, held-selection,
dimmed-dialog, Kitty-image, split-pane, large-resize and copy-selection pairs.
These are real viewer outputs replayed through Ghostty and
rasterized from captured cells; they are not UI mockups.

The scenarios cover:

- Styled Unicode and colors, followed by a one-row counter update.
- Hyperlink hover and a held live selection. The harness verifies highlighted
  backgrounds, confirms new text reached the source pane while its selected
  viewport remains frozen, then verifies it appears after release.
- A decoded Kitty picture, a menu cutting around it, and a rename dialog
  dimming the uncovered text colors by exactly half. The picture disappears
  while dimmed and returns when the dialog closes.
- Scrollback and an actual held mouse selection in scrollback. The harness
  checks visible highlighting, exits with `q`, and verifies no stale history
  or SCROLL footer remains before creating split panes.
- Split panes after both child fixtures have painted, focus changes, zoom,
  help, scope hover, and shrink/grow resizes.

Visual fixtures disable resource values and the ordinary Corgi animation to
remove unrelated time variance. Help uses a 48×24 viewport where its separately
animated footer is absent. Other captures use 120×36, then 60×20 and 140×45.
No cells are masked to make the comparisons pass. The performance fixtures
retain the normal resource sampler and animation intensity instead.

PNG generation uses Pillow 12.0.0 and installed DejaVu fonts. The ignored
`dist/retained-fonts/` holds the optional Noto symbol/math fallbacks and their
URL/SHA256 provenance; the final v6 run reports no missing glyphs.

```sh
env -u CORGI_NATIVE_ROOT -u BUN_OPTIONS bun tools/benchmarks/retained_visual.ts \
  dist/corgi-pr15 dist/corgi-retained-v6 dist/fresh-visual-output
```

Earlier preserved visual runs expose harness weaknesses rather than hidden
product differences: `self1` failed to wait for a resize; the first v2 run
captured a new baseline split before its program painted. The original v1
comparison matched seventeen screens, but its copy-selection label did not
actually exercise highlighting. The corrected nineteen-state harness asserts
those conditions explicitly before claiming coverage.

## Performance method

`retained_compare.py` owns the shared global benchmark lock. It runs baseline
then candidate on CPUs 8–15 with memory node 0, and reverses order on CPUs 72–79
with memory node 1. The observer stays outside those cores and their SMT
siblings. No team builds, tests or other measurements overlap the slot.
Sibling load is sampled every 500 ms; a whole-trial sibling mean over 10%
rejects the trial, while shorter bursts remain recorded. This is controlled
placement on a shared host, not physical isolation.

Sixteen alternating synthetic Claude/Codex agents plus a quiet shell receive
the same input. One agent is visible and all sixteen emit twenty updates/s.
The normal stream scrolls approximately 130-byte lines; `sparse` overwrites one
row at the same cadence. All provider accounts, projects and sockets are
isolated. Provider/PTY-consumer CPU is excluded. Daemon/viewer CPU includes all
their threads; 100% means one core. Child CPU is separately recorded waited-for
child time, not a complete live process subtree.

The harness checks all agent identities/activity, visible source progress and
a separate three-second cadence probe. In addition to the absolute guards,
candidate mean visible progress and cadence must remain at least 95% of the
reference. The same probe separately records timestamped working-spinner cells
in the sidebar. Their positions must remain stable and visible, with at least
ten glyph changes/s and no unchanged interval above 250 ms; the normal spinner
advances every 80 ms (12.5 Hz). Candidate animation cadence must also remain at
least 95% of the reference. These receipts come from rendered output, not timer
or callback counts, and all probing happens outside the CPU sample.
Terminal byte output may not rise beyond the greater of 25% or
200 B/s. Geometry snapshots are retained; `--match-geometry` can size every
pane to 132×47. Process RSS uses each phase's median; it is not allocation
throughput or uniquely owned memory. Per-thread ticks in each `host.json` can
be summarized with `cost_threads.py` to identify compilation settling.

`composition_costs.ts` separates frozen-input differ timing from surface
installation plus composition. The latter uses one production `mirror.Terminal`
per method and successive canonical wire views produced by one source terminal.
It covers unchanged cells, cursor-only changes, one-row overwrites, scrolling,
and varied Unicode/color content, each with static or changing surrounding UI.
Frozen PR15 JSON installation plus full replay and current full row installation
plus full replay are separate references. Every method must reproduce the frozen
output bytes and complete terminal surface before timing. Native diagnostics
record damaged rows, exact compared cells, and retained storage capacities;
capacities do not count allocation traffic. UI generation, producer capture,
wire parsing and actual terminal output remain outside these microbenchmarks.

```sh
# Four ordinary phases: idle/streaming, attached/detached.
env -u CORGI_NATIVE_ROOT -u BUN_OPTIONS python3 tools/benchmarks/retained_compare.py \
  dist/corgi-pr15 dist/corgi-retained-v2 dist/fresh-default-output

# Attached streaming: 120-second warmup, 60-second sample, AB/BA placements.
env -u CORGI_NATIVE_ROOT -u BUN_OPTIONS python3 tools/benchmarks/retained_compare.py \
  dist/corgi-pr15 dist/corgi-retained-v2 dist/fresh-warm-output --scenario warm-stream

# One paired placement for the sparse-row diagnostic.
env -u CORGI_NATIVE_ROOT -u BUN_OPTIONS python3 tools/benchmarks/retained_compare.py \
  dist/corgi-pr15 dist/corgi-retained-v2 dist/fresh-sparse-output --scenario sparse --pairs 1
```

The v1 smoke pair did not show an uplift: 20.07% reference versus 20.87%
candidate total CPU, with 60 seconds warmup and a 30-second sample. Output
quality, native provenance and sibling-load checks passed. This single pair
motivated further implementation work; it does not establish a precise
regression. Its accepted baseline was preserved after a coordinator progress
printer failed, and resumed only after verifying unchanged binaries, fixture
hashes and measurement arguments. Final replicated comparisons use fresh runs.

The fresh v2 smoke pair also did not show an uplift: 19.87% reference versus
19.93% candidate total CPU. Viewer CPU was 7.87% versus 8.13%; observed viewer
main-thread CPU was 5.52% versus 5.94%, so extra compilation alone does not
explain the absence of a gain. Both delivered approximately twenty visible
changes/s, with worst observed gaps near 52 ms and less than 1% byte-rate
difference. Maximum sibling means were below 0.8%. Raw results and thread
samples are in `dist/retained-v2-smoke/`. These smoke trials use 60-second
warmups and 30-second windows; they guide implementation iteration rather than
establishing a replicated final performance claim.
