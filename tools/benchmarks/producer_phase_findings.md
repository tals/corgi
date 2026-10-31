# Producer phase is an uncontrolled variable in the historical macro fixture

The historical macro fixture fixed each agent's nominal frequency, but did not
control or record timing between its sixteen producers. This limitation applies
to the recorded Corgi/Herdr comparisons and the V14/V15 balanced block. Their
existing acceptance decisions remain unchanged; reported ratios describe these
observed workloads, not a phase-controlled comparison.

The executed source copied in
`dist/retained-v15-v14-sparse-node0/harness/cpu.ts` installs a separate
`setInterval(..., 50)` when each provider receives `stream` (line 246). The
harness sends those commands sequentially with an awaited Corgi CLI process for
each pane (line 315). The pinned Herdr harness uses the same interval expression
(`cost_matrix_herdr.ts:147`) but starts it through sequential RPC sends (line
378); each RPC opens a new Socket (`166–193`). There is no shared epoch, arming
barrier or explicit lane offset. `observation_costs_fixture.ts` only supplies
optional transcript history; it adds no scheduling control.

Initial phases consequently depend on command delivery and product-specific
startup costs; independent timer scheduling can introduce drift. The visible
pane's approximately 20 Hz progress and spinner checks do not reveal whether
the other fifteen streams coincide, cluster or spread evenly over a 50 ms cycle.
The retained macro output has no per-producer write timestamps, so those phase
relationships cannot be reconstructed from it. The separate readiness micro
already showed that aligned versus staggered traffic can materially change
reporter/send activity. That motivates a controlled fixture; it does not prove
that phase alone caused any particular historical CPU difference.

## Common fixture design

Both products must install exactly the same provider implementation. The parent
chooses one future host-wide epoch and a deterministic lane offset: zero for
aligned traffic, or `lane × 50 ms / 16` for the staggered scenario. Keep these
as separate workloads. Every provider emits a one-time armed receipt before the
start deadline; missing or late receipts abort the trial before measurement.
Timers target absolute deadlines instead of adding another relative interval
after each callback. A late callback must record skipped slots rather than
silently emit a catch-up burst.

Use a real shared Linux monotonic clock. In the pinned Bun 1.4.4 source,
`process.hrtime.bigint()` is **also VM-relative**, not suitable as a shared epoch:
`src/jsc/bindings/BunProcess.cpp:1004–1007` calls `Bun__readOriginTimer`, whose
implementation in `src/jsc/virtual_machine_exports.rs:36–41` returns
`vm.origin_timer.elapsed()`. That origin is initialized for the VM in
`src/jsc/VirtualMachine.rs:3332`. The source checkout is
`/home/t/dev/vendor/bun-corgi-boundaries-20261026`, pinned commit
`38afee6c84fcf48c0edb2466aa4b27d287a59c30`.

A common benchmark-only libc `clock_gettime(CLOCK_MONOTONIC)` FFI binding with a
preallocated timespec avoids that origin error. Record scheduled index and
pre/post-write timestamps into preallocated per-provider storage. A synchronous
single write per payload provides a defined kernel-write boundary. Flush the
trace only on an explicit command after CPU and quality windows; no per-write
file logging belongs inside measurement. Validate every lane's progress, drops,
lateness and relative phase from those traces. Keep the existing 120-second
warmup, 60-second sample, terminal/spinner checks, topology and noise guards.
This new generator protocol must be validated before further product timing.

## Replacement fixture validation

The shared implementation is now `streaming_fixture.ts` plus
`streaming_provider.ts.fixture`; both Corgi and Herdr install the same source.
`CPU_STREAM_PHASE=aligned|staggered` selects a controlled schedule; `independent`
retains the historical scheduling mode explicitly. Coordinators expose this as
`--producer-phase`, record it, and reject differing provider/runtime source
hashes or missing/invalid controlled-phase receipts. No production files changed.

The guard values were fixed before the first producer run: every arm must arrive
at least one second before the common epoch (chosen five seconds ahead); zero
missing scheduled writes within the CPU-window interior; per-lane p99 lateness
at most 2 ms and maximum below 25 ms; aligned p99 same-index cross-lane spread
at most 3 ms and maximum below 25 ms. One 50 ms period at each CPU-window edge
is excluded from strict deadline matching. Actual byte counts and monotonically
ordered write records are checked. Numerical quality failures are saved before
rejection. These limits have not been relaxed.

The correctness harness passed eight checks: actual cross-process clock epoch,
provider late-arm rejection, parent late-barrier rejection, 16-lane aligned
quality, rejection of a missing write, rejection of excessive lateness, rejection
of an incorrect byte count, and 16-lane staggered quality. The standalone aligned
p99 spread was 1.339 ms; worst per-lane p99 lateness was 1.509 ms aligned and
1.660 ms staggered. All measured windows had zero dropped deadlines.

Short real-PTY preflights then passed for both products in both schedules,
using 16 agents, 5-second warmups and 5-second samples with the ordinary geometry,
agent, progress, clamp, native-identity, cleanup and strict noise checks. These
are correctness evidence, not CPU comparisons. The first Herdr setup stopped
before launch because the output path exceeded the Unix socket limit; the whole
attempt remains preserved. Fresh short `/tmp` paths fixed that setup problem
without changing the harness, binaries, phase thresholds or quality guards.

Frozen observer8 uses a baseline source export overlaid with the archived V15
support source and a private copy of the V14/V15 native assets. It imports no
mutable production source. Provenance is
`dist/producer-phase-observer8-receipt.json`; the concise validation extraction is
`dist/producer-phase-validation-summary.json`. Raw standalone checks are
`dist/producer-phase-check1/`. Real product preflights are linked from
`dist/producer-phase-preflight-aligned-retry1/` and
`dist/producer-phase-preflight-staggered/`, with copied harnesses, phase traces
and artifact manifests.

## First controlled product pair

The first aligned sparse pair used V15 and pinned Herdr v0.9.5, 16 providers,
matched 132×47 pane geometry, default Corgi decorations and resources, a
120-second warmup and a 60-second CPU window. A fresh 60-second host-only pilot
selected NUMA node 0, CPUs 40–47 (L3 5), with siblings 168–175 monitored. Both
products received the same per-task utilization clamp. Frequency remains a
diagnostic, not a normalization factor. Product order was declared Corgi then
Herdr before either application ran.

Both trials passed their original guards on the first attempt. Corgi used
4.283% daemon plus 1.800% viewer CPU; Herdr used 3.383% plus 0.233%. These are
percentages of one logical CPU, with provider CPU excluded. The observed total
ratio was 1.682×, from one directional pair. It is not a confidence interval or
a claim of product parity. The viewer accounts for about 64% of the observed
2.467 percentage-point gap.

Both products recorded 19,168 interior writes with zero missing deadlines.
Worst-lane p99 lateness was 1.413 ms for Corgi and 1.379 ms for Herdr; aligned
cross-lane p99 spread was 1.607 and 1.408 ms. Whole-trial sibling CPU means
stayed below 0.433%. The ordinary pane progress and Corgi spinner guards also
passed. Post-window PSS was 89.34/68.73 MiB for Corgi daemon/viewer and
20.32/9.05 MiB for Herdr; those memory snapshots include the runtime and all
enabled features, not just retained terminal storage.

Raw evidence is linked at `dist/retained-v15-herdr-controlled-aligned/`, including
`pair-summary.json`, `threads-summary.json` and `artifact-manifest.json`.
The staggered pair then completed on the same placement and in the same product
order, after the recorded root validation/build interlude. Corgi used 4.967%
daemon plus 1.667% viewer CPU; Herdr used 3.617% plus 0.200%. The directional
total ratio was 1.738×. One Corgi attempt was rejected by the unchanged whole-trial
sibling guard (4.935%); its measured window was quieter, but that does not change
the declared rejection. The second Corgi attempt and first Herdr attempt passed,
with whole-trial sibling maxima of 0.369% and 0.190%.

Both accepted staggered trials again recorded 19,168 interior writes with zero
dropped deadlines. Worst-lane p99 lateness was 1.392/1.467 ms, and pane progress
remained approximately 20 Hz. Corgi's informative spinner remained at 12.33 Hz.
Post-window PSS was 89.85/69.03 MiB for Corgi daemon/viewer and 20.48/9.04 MiB
for Herdr. Corgi's sampled readiness-thread CPU rose from 0.271% aligned to
0.723% staggered, while daemon main-thread CPU rose from 2.592% to 2.842%.
These sequential observations fit the batching mechanism; repeats are needed
for a causal effect estimate. Viewer CPU remains the larger cross-product gap
in the aligned case and a similar gap to daemon CPU in the staggered case.

Staggered evidence is linked at `dist/retained-v15-herdr-controlled-staggered/`.
The combined extraction is `dist/producer-phase-product-summary.json`; the
declared plan and interlude are in `dist/producer-phase-product-plan.json`.
All trials retain raw per-thread user/system counters, post-window memory,
actual producer traces, loaded-native hashes, frequency diagnostics and copied
harness sources. The frequency values are neither normalized nor used to infer
effective execution cycles. Each scenario still has only one accepted trial
per product, in Corgi-then-Herdr order.

## V16 ownership experiment

The next frozen candidate ran on the same placement, with the declared reverse
product order: fresh Herdr then V16 for aligned traffic, followed by fresh Herdr
then V16 for staggered traffic. Observer9 changes only explicit paired order
selection and postprocessing classification of the new `corgi-pty-read` thread;
its provider, quality guards and frozen V15 support/native source are unchanged.
The compiled V16 product loads and verifies its own distinct embedded native.

| Schedule | V16 daemon | V16 viewer | V16 total | Fresh Herdr daemon | Fresh Herdr viewer | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aligned | 4.133% | 1.817% | 5.950% | 3.183% | 0.217% | 1.750× |
| Staggered | 4.900% | 1.683% | 6.583% | 3.183% | 0.200% | 1.946× |

All four trials passed their original guards on the first attempt, with zero
dropped deadlines among 19,168 interior writes per trial. Worst-lane p99 lateness
was 1.509 ms or lower. Corgi pane updates stayed approximately 20 Hz and spinner
updates 12.3–12.7 Hz. Whole-trial sibling means stayed below 0.399%.

V16 does not show a meaningful whole-app gain: its sequential total changes
against V15 are −0.133/−0.050 points, while the repeated Herdr references moved
−0.217/−0.433 points. The new reader consumes much of the work removed from the
main thread. Each case remains a single directional pair, not a repeated causal
estimate. The decision is to reject production adoption of V16's added machinery
while retaining its passing validation and frozen source/results.

See [the reader experiment](pty_reader_findings.md) for thread cancellation and
the limits of transferring the earlier component gain. Raw output is linked at
`dist/retained-v16-herdr-controlled-{aligned,staggered}/`, and the combined
summary is `dist/producer-phase-v16-summary.json`. The prospective plan is
`dist/producer-phase-v16-plan.json`; `dist/producer-phase-observer9-receipt.json`
records the frozen support tree and the two changed harness files.
