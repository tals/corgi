# Corgi / Herdr terminal-maintenance comparison

The latest V18 [agent-count matrix](agent_scale_findings.md) measures all twelve
idle/busy, attached/detached and 4/8/32-agent scenarios, with daemon and viewer
CPU separated. It includes clearly marked observations affected by host noise
and a material waited-child CPU caveat. Its 30-second warmups and 60-second
samples are a separate characterization from the historical results below.

The historical comparisons below used sixteen independent producer timers. Their relative write phases were neither controlled nor recorded, so these ratios are observed workload results, not phase-controlled product comparisons. Existing acceptance decisions remain unchanged. See [the producer-phase audit](producer_phase_findings.md) for the limitation and replacement fixture.

The first controlled V15 sparse pairs now show total CPU ratios of 1.682× with
aligned producers and 1.738× with staggered producers. Each is one directional
pair, with default Corgi features retained; they are not confidence estimates
or parity claims. Their methodology, rejected attempt and raw evidence are in
[the controlled product results](producer_phase_findings.md#first-controlled-product-pair).

The later same-product V15/V18 aligned ABBA block found combined CPU effectively
flat (5.983% → 6.008%) and viewer PSS lower (67.87 → 59.80 MiB). V18 combines
a conservative viewer wait cap with native mirror eviction. Its calibration
flagged up to 13.03% throughput drift, so small CPU differences remain tentative.
No fresh Herdr trial accompanied that block, and its newly selected placement
differs from the V15/Herdr pairs: do not divide these separate observations to
invent a V18/Herdr ratio. See [the V18 evidence](viewer_heartbeat_findings.md).

Baseline: Corgi PR #15, `fb129d2ef96511a3c727112e0d1df2191bb5b241`.
Herdr: official Linux x86_64 v0.9.5 binary, SHA256
`14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`;
source tag `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`, clean local checkout.
This is a fixed-version comparison, not a claim about the latest Herdr release.

## Measured default-product costs

Means of two matched samples per product, with reversed order on the second
NUMA node; CPU percent is one core = 100%. All four trials passed quality and
cleanup checks without a retry.

| Phase | Corgi daemon | Herdr daemon | Corgi viewer | Herdr viewer | Corgi total | Herdr total | Corgi / Herdr |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle, attached | 3.80% | 0.80% | 2.67% | 0.13% | 6.47% | 0.93% | 6.93× |
| Streaming, attached | 12.33% | 13.17% | 8.20% | 0.67% | 20.53% | 13.83% | 1.48× |
| Streaming, detached | 9.17% | 7.23% | — | — | 9.17% | 7.23% | 1.27× |
| Idle, detached | 2.57% | 0.83% | — | — | 2.57% | 0.83% | 3.08× |

The strongest streaming gap in this baseline is the viewer: **7.53 percentage
points of one core**, while Corgi's attached daemon is slightly cheaper in this
fixture. This is a cost budget to investigate, not a claim that all 7.53 points
can be removed: UI animation and product behavior differ. Corgi sends 26.4 KB/s
to the outer terminal versus Herdr's 9.7 KB/s; idle attached output is about
276 B/s versus zero. Those are emitted terminal bytes, not socket traffic or
internal allocation volumes.

Ranges across the two samples, Corgi then Herdr: idle attached 6.33–6.60% vs
0.87–1.00%; streaming attached 19.47–21.60% vs 13.73–13.93%; streaming detached
8.13–10.20% vs 7.19–7.26%; idle detached 2.33–2.80% vs 0.73–0.93%.
The Corgi streaming variation is material; these are estimates on a shared host.
The maximum SMT-sibling whole-trial average was 5.76%, below the 10% rejection
bound, but half-second bursts reached 38%. Raw samples retain them.

| Phase | Corgi daemon RSS | Herdr daemon RSS | Corgi viewer RSS | Herdr viewer RSS |
| --- | ---: | ---: | ---: | ---: |
| Idle, attached | 94.6 MiB | 24.8 MiB | 76.4 MiB | 14.9 MiB |
| Streaming, attached | 110.4 MiB | 29.8 MiB | 81.8 MiB | 14.9 MiB |
| Streaming, detached | 122.2 MiB | 37.1 MiB | — | — |
| Idle, detached | 127.2 MiB | 28.6 MiB | — | — |

RSS entries average each trial's phase median. The final idle phase follows
streaming and includes retained heap/scrollback; this does not establish a leak
or allocation rate. Shared resident pages can occur in both process RSS values.
Waited-for child CPU was zero in these samples.

Local raw data: `dist/cost-matrix-default/comparison.json`,
`summary.json`, per-trial snapshots/logs and `*-samples.json` (also retained at
the original `/tmp/corgi-cost-matrix-20261025/` path). Binary/native
provenance is retained in the manifest and `native-provenance.json`. The baseline
manifest records the harness hashes used for this run; later additions of
optional matched geometry and telemetry support change source hashes, not the
already frozen baseline binary or these recorded measurements.

## Followup with matched terminal geometry

A separate node-0 pair gives **every agent PTY 132×47 cells**. Corgi focuses each
pane during setup and restores the quiet shell. Herdr uses a 159×48 outer
terminal, Corgi 160×48, because their chrome widths differ. Herdr's pane API
layout includes a scrollbar column: a 133×47 layout contains a 132×47 PTY.
Using a 158-column outer terminal initially failed the strict check with an
actual 131-column PTY; the corrected run did not relax the required dimensions.

The shared helper opens each isolated provider's `/proc/PID/fd/0` and calls the
existing winsize ioctl outside CPU timing. Every phase checks actual sizes,
including detached phases. Herdr's actual PTYs remain 132×47 when detached,
even though its API layout switches to 120×40. This corrects the historical
comparison's assumption that the detached API layout measured PTY dimensions.

| Phase | Corgi daemon | Herdr daemon | Corgi viewer | Herdr viewer | Corgi total | Herdr total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle, attached | 2.53% | 0.73% | 2.40% | 0.13% | 4.93% | 0.87% |
| Streaming, attached | 14.40% | 13.60% | 8.00% | 0.53% | 22.40% | 14.13% |
| Streaming, detached | 10.93% | 7.66% | — | — | 10.93% | 7.66% |
| Idle, detached | 2.46% | 0.80% | — | — | 2.46% | 0.80% |

The **7.47-point viewer gap persists** after matching inner geometry. Streaming
attached total is 1.58× Herdr; detached is 1.43×. This pair is a one-sample
diagnostic on one NUMA node, not another replicated speed ranking. Comparing
its values against the earlier default matrix does not isolate geometry's
causal effect: the trials ran later and Corgi's setup visited every tab.
Both products still differ in visible UI behavior and services.

The largest sibling average in this pair was under 1%; no retries were needed.
Raw results, actual dimensions and a compact summary are under
`dist/cost-matrix-geometry/` (also `/tmp/corgi-cost-geometry-20261025/`). Reproduce
with the command below using a
fresh output directory and `--match-geometry --pairs 1`.

## Reproduction

Build Corgi before reserving the measurement slot. The baseline used the native
libraries already built in the PR #15 worktree; `CORGI_NATIVE_ROOT` also points
the source harness and measured Corgi processes at that unchanged directory.
`dist/corgi-pr15.build.json` records their aggregate hash and build provenance. No build/setup time enters
steady-state results.

```sh
CORGI_NATIVE_ROOT=/home/t/dev/personal/corgi-perf-compact-20261025/native/zig-out \
  python3 tools/benchmarks/cost_matrix.py \
  dist/corgi-pr15 /home/t/dev/personal/herdr-cpu-benchmark/herdr-v0.9.5 \
  /tmp/corgi-cost-matrix-20261025
```

The coordinator holds the existing global benchmark lock, runs Corgi then Herdr
on CPUs 8–15/node 0, then Herdr then Corgi on CPUs 72–79/node 1. Both CPU affinity
and memory policy are bound. The observer runs on CPU 0. Each trial contains
16 alternating Claude/Codex agents plus the initial quiet shell; 160×48 outer
terminal; 20 seconds initial warmup, five seconds between later phases, and
15-second CPU windows. Streaming requests one approximately 130-byte line per
agent every 50 ms. One agent is visible; other streams continue in hidden tabs.

The four phases are idle attached, streaming attached, streaming detached,
idle detached. Linux process `utime+stime` includes all threads; 100% is one
core. Child CPU is reported separately: it is Linux's waited-for child time,
not all still-running provider or helper CPU. Fake providers, PTY consumers,
watchdogs and observers are excluded. RSS is sampled every 500 ms and aligned
to each phase's actual timestamps; it measures resident footprint, not allocation
throughput or uniquely owned memory. No GPU work is exercised.

Both harnesses validate all agent identities and activity states, measure visible
sequence progress, and separately probe visible cadence for three seconds. The
same bounds require 12–26 lines/s, source lead of 0–10 lines, at least 12 visible
changes/s and no observed gap over 250 ms. These are output-quality guards, not
input latency. Source reads happen just after timing and may lead the received
screen. Every trial must contain all four phases and clean up its owned processes.

Raw `/proc/stat` deltas preserve selected-core and SMT-sibling load. A trial is
rejected/repeated if any sibling averages over 10% busy. Half-second sibling
loads are also retained; passing the whole-trial guard does not rule out short
disturbances or external activity on selected CPUs. Two placements/repetitions
provide a reproducibility check, not a confidence interval.

## What is and is not equivalent

The provider source and requested line rate match. Both use their default
client-composed UI with daemon-owned terminal surfaces. Herdr's ordinary viewer
is **not** raw PTY forwarding: `src/client/mod.rs:188` selects ClientShell,
and `src/protocol/wire.rs` defines semantic frame transport.

The user-visible work differs. Herdr's sidebar stays static in these scenes;
Corgi animates agents and samples CPU/RAM. Herdr v0.9.5 has no corresponding
resource meter in the inspected source. The workload deliberately retains these
defaults; differences establish an overhead budget, not an attribution to Rust,
Bun, Zig or any one feature.

Default pane sizes differ: Herdr's attached pane layouts are 134×47, including
hidden tabs. Corgi's visible pane is 132×47; never focused panes remain 80×24.
Herdr's detached API layout reports 120×40, but its terminal scroll metadata
retains a 47-row viewport; the source does not resize all PTYs when the last
shell client disappears. Do not mistake the API's default headless layout for a
measurement of actual detached terminal dimensions. Per-phase snapshots retain
both layout and viewport metadata.
The roughly 130-character fixture lines consequently wrap twice in Corgi's
15 hidden 80-column panes, once in Herdr's wider panes. Ignoring initial fill,
that requests about 620 versus 320 row advances/s at 16 agents with one visible
pane. These counts follow from the fixture and dimensions, not a measured
scroll-operation counter. Any pure terminal engine comparison must fix inner
geometry and input bytes; this product comparison does not do that.

Fixtures have minimal transcripts, no real tool traffic and no bound Codex
app-server session polling in Corgi. The temporary project is not a Git repository,
so this does not characterize expensive Git/worktree/push detection. These costs
need separate controlled workloads. No real accounts, models or network provider
calls are used.

## Mechanisms supported by source inspection

Herdr's [render signal](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/render_signal.rs)
retains the identities of PTY/title sources while coalescing wakes. The
[headless loop](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/headless.rs)
checks whether a PTY-only dirty set is visible to any client before rendering.
Hidden-only terminal writes still enter the emulators but skip presentation.
This makes visible presentation proportional to visible damage rather than all
background terminal activity. Generic state changes can still require full work.

The [retained surface path](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/headless/retained_surface.rs)
collects dirty terminal rows, emits changed cell spans, and retains a complete
surface for subsequent updates. It falls back to full rendering when geometry
or unsupported state changes. This is not allocation-free: it builds vectors
and clones state in several branches. Its advantage is reducing the volume of
work and data for small changes, at a cost in retained state and invalidation
rules. Corgi PR #15 intentionally omitted the prior larger retained-state
experiments; that tradeoff must be measured before reviving their complexity.

Herdr [detection](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/pane/agent_detection.rs)
uses terminal content sequence counters to skip unchanged idle-agent screens.
Unidentified-pane text also has a revision cache, with writer overlap checks.
The [pane task](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/pane.rs)
normally wakes at 300 ms for identified agents and 500 ms otherwise, with faster
transitional checks; known process identity has a five-second periodic recheck.
This distinguishes observing lifecycle state from reconstructing all screen
text on every observation. Costs still scale with the number of panes, while
content extraction depends on dirty screens and active-state rules.

Herdr's internal [wire encoder](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/protocol/wire.rs)
uses length-prefixed bincode. Corgi has JSON/native crossings and JSON snapshot
hashes, but binary serialization alone cannot explain the CPU gap: bytes
materialized, unchanged data re-read and total update count must be measured.
The terminal microbenchmarks cover that narrower question.

Herdr also has opt-in
[render telemetry](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/render_prof.rs)
(`HERDR_RENDER_PROF=1`): counters, duration counts/totals/maxima, and one-second
aggregated logs. It is disabled in the comparison. The implementation uses a
mutex and maps when enabled; its timings are elapsed durations, not per-thread
CPU attribution. Use a separate diagnostic run to explain render work, and
measure its enabled overhead before relying on it for fine cost estimates.

## Corgi process threads and warmup

Separate diagnostics use the instrumented Corgi binary and the same sixteen
agents plus quiet shell. They are not additional Herdr ranking samples.
`cost_probe.py` records Linux per-thread user/system ticks every 500 ms;
`cost_threads.py` groups the saved samples and compares the first/last ten
seconds of each phase. `dist/thread-analysis.json` retains the grouped values,
window lengths and thread-ID changes. Whole-process CPU remains the authoritative
total: thread windows use inner sampling boundaries and exclude threads missing
at either endpoint, including short-lived compiler threads.
The summary also includes adjacent-sample deltas, which retain more work from
threads that exit within a phase but still miss unobserved lifetime edges.

The longer node-1 diagnostics use a 30-second initial warmup, 15-second later
warmups and 20-second measurement windows. The table shows attached streaming
CPU, with 100% equal to one core. Heap/scavenger combines `HeapHelper` and
`mi-scavenger`; other small runtime pools are omitted from these columns.

| Diagnostic | Process | Total | Main thread | JITWorker | Heap/scavenger | Worker | FD readiness |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node 0, telemetry off | Daemon | 12.67% | 8.40% | 1.77% | 0.85% | 0.71% | 0.92% |
| Node 0, telemetry off | Viewer | 8.93% | 6.07% | 1.84% | 0.92% | — | — |
| Node 1, longer, telemetry off | Daemon | 13.25% | 8.92% | 1.47% | 0.91% | 0.71% | 0.96% |
| Node 1, longer, telemetry off | Viewer | 7.10% | 5.58% | 0.66% | 0.86% | — | — |
| Node 1, longer, minimal history | Daemon | 13.10% | 9.07% | 1.32% | 0.76% | 0.66% | 0.96% |
| Node 1, longer, minimal history | Viewer | 7.35% | 5.62% | 0.96% | 0.76% | — | — |
| Node 1, longer, seeded history | Daemon | 14.20% | 9.55% | 1.78% | 0.76% | 0.71% | 0.97% |
| Node 1, longer, seeded history | Viewer | 8.35% | 6.40% | 0.91% | 0.76% | — | — |
| Node 1, 120 s warmup / 60 s streaming | Daemon | 11.37% | 8.33% | 0.47% | 1.01% | 0.72% | 0.60% |
| Node 1, 120 s warmup / 60 s streaming | Viewer | 7.05% | 5.37% | 0.59% | 0.96% | — | — |

Runtime auxiliary threads account for material CPU that main-thread elapsed
spans cannot explain. Their names do not establish which application allocation
or operation caused their work. In particular, heap-thread activity is not an
allocation-rate measurement. The resource worker's own telemetry CPU reading is
process-wide and must not be added to the process total; the `Worker` values
above instead come from its Linux thread ticks.

Compilation is still settling in some streaming windows. With telemetry off in
the longer node-1 run, daemon JIT drops from 2.39% to 0.62% and viewer JIT drops
from 0.94% to 0.42% across the first/last ten seconds. In the longer minimal
history run, daemon JIT CPU falls from 2.18% in the first ten seconds to 0.52%
in the last ten, and viewer JIT falls from 1.56% to 0.42%. With seeded history,
daemon JIT falls from 2.50% to 1.15%, while viewer JIT stays at 0.94%. Detached
streaming daemon JIT stays around 0.73%→0.63% and 0.83%→0.94%, respectively.
These are mixed patterns, not evidence that all JIT cost persists indefinitely
or that the chosen warmup reaches steady state. Longer steady-load observations
would be needed to separate compilation settling from recurring runtime work.

A followup runs only attached streaming, warms it for 120 seconds, then measures
60 seconds with minimal history and telemetry enabled. The maximum sibling
average is 0.56%. Main-thread CPU stays within 8.12–8.67% daemon and 5.21–5.63%
viewer across ten-second windows. JIT continues to fall: daemon windows measure
1.04%, 0.52%, 0.31%, 0.44%, 0.21%, 0.21%; viewer windows measure 0.94%, 1.15%,
0.31%, 0.66%, 0.31%, 0.21%. Much of the earlier JIT budget was settling, while
the main-thread work and heap/scavenger activity persist throughout this
observed minute. The final 0.21% JIT readings do not prove an indefinite steady
cost. This longer Corgi-only diagnostic cannot replace the original paired
Herdr comparison or establish an adjusted cross-product ratio.

The "seeded history" mode is `CPU_RICH_TRANSCRIPTS=1`: one historical Claude
assistant usage record and a turn-duration record per Claude session. It does
not simulate a large, growing transcript or real tool calls. Node-0 minimal
telemetry exceeded the 10% sibling-load rejection bound (13.1%); its counters
can describe work performed but its CPU cannot establish telemetry overhead.
The longer telemetry-off, minimal and seeded-history node-1 trials had maximum
sibling means of 1.71%, 0.69% and 1.21%, respectively. These single diagnostic runs still do not
provide a confidence interval or causal overhead estimate by themselves.

Setting Corgi animation intensity to zero in another longer node-1 diagnostic
reduces the idle viewer to 0.95% process CPU and 0.47% main-thread CPU, versus
2.50% and 1.20% in the minimal-history run. Attached streaming remains 7.65%
process and 5.69% main-thread CPU, versus 7.35% and 5.62%. This suggests a
substantial idle animation cost while the streaming main-thread work persists;
it is one diagnostic pair, not a precise causal savings bound. Other timed UI
behavior remains enabled. The maximum sibling average is 1.10%. The idle viewer
also illustrates thread lifetime bias: whole-phase endpoint grouping misses an
exited JIT thread, while adjacent-sample grouping captures 0.31% JIT CPU.

Bun profiles and these process measurements answer different questions. The
saved CPU profiles have sleep-sized gaps between some samples. Assigning each
gap's entire duration to the sampled stack would charge idle time to whichever
function is sampled next. Phase-filtered sample counts can rank sampled
main-thread hotspots; they are not percentages of whole-process CPU and do not
cover the runtime threads above. Elapsed telemetry spans additionally overlap
and include scheduling delays and waits.

The streaming counters show about 319 feeds/s and 637 drain invocations/s.
`Terminal.attachReadiness` drains on readiness; the server subsequently calls
`Terminal.read`, which drains again before ticking. This supports repeated
drain attempts, not two kernel output chunks per program line. The same source
path unconditionally sends native `flush` on readiness and checks `takeCopied`
after a changed tick. Guards or a combined tick response are candidates to
measure, not demonstrated savings; pending writes and OSC clipboard behavior
must remain correct.

## V9 component verification and isolated costs

`dist/component-v9-summary.json` compares immutable v8 and v9 source/native
trees. It keeps process CPU means and trial ranges separately from the real
application comparisons. The producer harness loads both DSOs in one process
and alternates three trials per stage. The Controller harness runs v8 then v9
on node 0 and reverses that order on node 1, with five trials per case. All
measurements hold the global benchmark lock. Maximum sibling mean load is
0.32% on node 0 and 3.27% on node 1; host frequency samples are retained.

Producer verification compares 366 full views, including cursor, modes,
selection, viewport, resize, reverse video, hyperlinks and synchronized output.
Only the deliberately per-instance surface identity is normalized. Controller
verification compares 336 frames across seven animation/content cases, with
identical full ANSI, emitted diff output, styled surface hashes and output
counts. Timed Controller output byte counts and nonempty counts also match.
The first unseeded Controller fixture exposed animation entropy; its artifacts
are preserved, and the final fixture resets public presentation state and uses
the same explicit seed for both versions.

| Component operation | V8 CPU µs | V9 CPU µs | Reduction across nodes |
| --- | ---: | ---: | ---: |
| Sparse native capture | 122.3–123.0 | 31.4–32.8 | 73.3–74.3% |
| Sparse feed, capture, JSON decode/reencode | 172.5–178.6 | 83.8–87.1 | 51.2–51.4% |
| Unchanged native capture | 109.3–113.2 | 14.8–15.1 | 86.5–86.6% |
| Scrolling native capture | 123.2–126.8 | 121.7–125.2 | 1.3% |
| Controller spinner frame | 332.2–347.3 | 74.0–75.5 | 77.7–78.3% |
| Controller sparse frame | 360.1–361.4 | 145.4–148.8 | 58.8–59.6% |
| Controller scrolling frame | 562.3–568.9 | 387.5–388.5 | 31.1–31.7% |

These ranges are the two node means, not confidence intervals. Producer sparse
updates format one row and reuse 46; unchanged/modes-only updates format zero
and reuse 47, while cursor movement conservatively formats about two. Scrolling,
reverse video and hyperlinks use the full invalidation path. Reverse-video
capture regresses 1.6–2.6%; hyperlink capture regresses 1.6–1.9%. The full
feed/JSON path is noisier for these cases and should not be called an improvement.
Cache payload is about 7.9 KB and retained row-buffer capacity 17.2 KB for this
132×47 fixture. Those values exclude caller snapshot copies, JSON and row
descriptors; the full wire format still sends every row.

Native capture timing excludes feed. The second producer stage includes feed,
capture and generic JSON decode/reencode, without sockets or the viewer.
Controller timing includes real UI planning, animation generation, retained
composition and diff output allocation; sparse/scroll additionally install
predecoded Mirror surfaces. It excludes daemon work, provider observations,
wire decoding, sleeping and stdout. Thus these percentages explain mechanisms
and must not be substituted for whole-application CPU savings.

## Controlling frequency requests in later comparisons

The v9 sparse pair passed functional and provenance checks, but its reported
selected-core busy-weighted frequencies differed substantially: Corgi 1.578 GHz,
Herdr 2.925 GHz. Herdr's maximum sibling mean was 9.00%, inside the original
10% bound. `dist/retained-v9-herdr-sparse/summary.json` explicitly excludes this
pair from causal comparison; its raw CPU ratio does not establish the product
gap. The earlier natural-setting evidence remains unchanged.

The optional `cost_matrix.py --uclamp` mode requests min=max1024 only for the
owned benchmark subtree. The observer retains natural clamps. It records each
live descendant thread's requested and effective clamps every second and
rejects failed inheritance. It also requires sibling means below 2% both over
the trial and inside each measured window, and paired reported frequencies
within 5%. The summary excludes ineligible placement pairs. `--node 1` runs
the reverse product order without repeating node 0.

This host has kernel task/group clamp support, the schedutil governor and no
restricting task/cgroup clamp limit. An owned sleeping process, its worker
thread and a child process all inherited requested/effective 1024/1024 while
the observer remained 0/1024. Evidence is in `dist/uclamp-support.json`,
`dist/uclamp-permission-check.json` and `dist/uclamp-harness-checks.json`.

These are performance requests while tasks are runnable, rather than a fixed
frequency or an effective-cycle measurement. Thermal, turbo and other runnable
tasks can still influence execution; the frequency guard and repetitions remain
necessary. The kernel documents the interaction with schedutil and cgroups in
its [utilization-clamp guide](https://docs.kernel.org/scheduler/sched-util-clamp.html).
Same-owner clamp-only changes and fork inheritance are supported by the
[Linux 6.8 scheduler](https://github.com/torvalds/linux/blob/v6.8/kernel/sched/core.c#L7164).
No host governor, system clamp or cgroup setting is changed. Later clamped
results must be compared with equally clamped baselines, never used to claim
savings against historical natural-clock trials.

The first full clamped v10 sparse pilot is retained in
`dist/retained-v10-herdr-sparse-clamped`. Corgi measures daemon 4.767% and viewer
1.850% CPU with pane 20.002 Hz and animation 12.335 Hz. The first Herdr attempt
is rejected for 3.72% measured-window sibling load. Its retry passes the sibling
and inheritance checks, measuring daemon 3.383% and viewer 0.217%, but the
pair still fails the predeclared frequency bound: 2.224 versus 2.396 GHz
(7.73% difference). The summary excludes the pair. This is evidence that
matching utilization-clamp requests alone does not ensure comparable observed
frequencies, not evidence of a causal cross-product CPU ratio or savings over
the earlier natural-clock binaries. Every observed application descendant
thread had the requested/effective clamp during both accepted CPU windows;
the observer's one-second clamp census averaged about 30 ms for Corgi and ran
on CPU 0 outside the measured application processes.

## Prospective repeated-comparison protocol

The exact running kernel's source changes how the frequency observations must
be interpreted. Ubuntu `6.8.0-146.146` reads recent APERF/MPERF deltas when the
scheduler-tick sample is at most 20 ms old. When stale or idle, it returns a
cached cpufreq policy value. `/proc/cpuinfo` MHz calls the same function.
Consequently, a 500 ms observer mixes recent busy-frequency snapshots and idle
fallback values. Weighting those reads by 500 ms CPU deltas or matching thread
endpoint CPUs cannot align the shorter hardware-sampling intervals. See the
exact [Ubuntu APERF/MPERF source](https://git.launchpad.net/~ubuntu-kernel/ubuntu/+source/linux/+git/noble/tree/arch/x86/kernel/cpu/aperfmperf.c?h=Ubuntu-6.8.0-146.146#n407)
and [CPU information reader](https://git.launchpad.net/~ubuntu-kernel/ubuntu/+source/linux/+git/noble/tree/arch/x86/kernel/cpu/proc.c?h=Ubuntu-6.8.0-146.146#n88).
Downloaded copies and hashes are retained under `dist/ubuntu-6.8.0-146-*`.

For future runs, these frequency distributions are diagnostic context, not a
causal eligibility criterion or a CPU normalization factor. The old pilot's
rejection status and raw records remain intact. New evidence should use an
explicitly versioned protocol with balanced, randomized product order and
repeated blocks on the same physical CPU sets. Application-dependent wakeups,
idle behavior and resulting DVFS are part of whole-application behavior under
the stated scheduling policy.

The proposed primary placement remains eight CPUs on one NUMA node with all
default application features and the existing geometry, bytes, animation and
pane-progress guards. Both products receive the same per-task clamp request.
Each block runs four fresh worlds in a predeclared random choice of ABBA or
BAAB order, with 120 seconds of streaming warmup and 60 seconds of measurement.
Sparse comes first, followed by a separate sparse diagnostic, then a scrolling
block on the other node. One block per workload takes about 14 minutes and
supports per-run ranges and a block contrast. It does not support a reliable
confidence claim by itself.

Final comparison needs at least four independent balanced blocks spread across
both nodes. Each block contributes one paired log CPU-ratio estimate; uncertainty
is computed across blocks, with per-node ranges also shown. Observer samples
within a run are correlated and are not additional independent repetitions.
Report absolute CPU percentage-point gaps alongside ratios, especially for
Herdr's small viewer cost: a 60-second `/proc/PID/stat` process measurement at
100 ticks/second has approximately 0.0167 percentage-point endpoint resolution.
Longer final windows can improve that resolution when small differences matter.

A stable-load calibration can bracket each block: one second of the pinned
system OpenSSL SHA-256 benchmark on each selected CPU, under the same clamp and
NUMA placement, before and after the block. Record executable/library hashes,
raw throughput and CPU usage. Flag substantial calibration drift, retaining
the whole block for inspection. Calibration describes continuous-load host
throughput; it neither recreates the application's intermittent duty cycle nor
provides a frequency correction. The [OpenSSL command documentation](https://docs.openssl.org/3.0/man1/openssl-speed/)
defines its fixed-buffer, duration and elapsed-time options.

Single-core placement is a useful later sensitivity check. It can change
provider batching, runtime pool behavior and scheduling contention, even when
output cadence passes. Keep that result separate from the primary eight-core
configuration and preserve the same feature settings.

## V10 pilot memory observations

| Process | Median RSS MiB | Postwindow PSS MiB | Postwindow private MiB |
| --- | ---: | ---: | ---: |
| Corgi daemon | 110.13 | 92.83 | 74.89 |
| Corgi viewer | 88.28 | 69.31 | 52.03 |
| Herdr daemon, clean retry | 26.30 | 20.57 | 14.78 |
| Herdr viewer, clean retry | 14.84 | 9.04 | 3.24 |

Combined PSS is 162.14 versus 29.61 MiB; combined private memory is 126.92
versus 18.02 MiB. RSS is sampled inside the CPU window; PSS/private values are
single snapshots after the CPU and cadence checks. These include runtime,
application services, provider metadata and mappings, while fake-provider child
memory is excluded. Sharing with unrelated live processes can affect PSS.
The CPU pair's frequency rejection does not erase these descriptive memory
observations, but they do not isolate retained-surface storage or establish an
allocation/leak rate. Raw figures are in the pilot's `memory-summary.json`.

## V11 sparse balanced block

The first prospective block is complete in
`dist/retained-v11-herdr-sparse-block1`: fixed seed 20261026 selected
Corgi–Herdr–Herdr–Corgi on node 0. Each accepted position uses a fresh world,
120 seconds of warmup and a 60-second window. Two early Corgi attempts failed
the original whole-trial sibling-load guard and remain rejected; the third
attempt and the other three positions pass unchanged. The eight per-core
calibrations changed by 0.12–6.39% from before to after the block, below the
predeclared 10% diagnostic flag. All inherited clamps, loaded binary/native
hashes, geometry, cadence and cleanup checks pass.

| CPU, percent of one core | Corgi mean (two-run range) | Herdr mean (two-run range) | Absolute gap |
| --- | ---: | ---: | ---: |
| Daemon | 5.083 (5.033–5.133) | 3.100 (2.950–3.250) | 1.983 points |
| Viewer | 1.925 (1.867–1.983) | 0.217 (0.217–0.217) | 1.708 points |
| Combined | 7.008 (6.900–7.117) | 3.317 (3.167–3.467) | 3.692 points |

The combined block ratio is 2.113; the viewer ratio is 8.885. These describe one
exploratory block, without a confidence interval or a comparability claim.
Herdr's tiny viewer denominator also makes its ratio sensitive to tick
quantization. Application-dependent DVFS remains part of this specified
clamped, eight-core configuration, and no frequency normalization is applied.

Clean Corgi thread means are daemon main 3.212%, FD readiness 0.497%, resource
worker 0.531%, JIT 0.236%, heap helper 0.177% and scavenger 0.303%; viewer main
1.399%, JIT 0.219%, heap helper 0.118% and scavenger 0.202%. Herdr places much
of its daemon work on other threads: main 0.446%, other 2.665%. These thread
windows have endpoint/quantization limits and are not substitutes for the
whole-process measurements above.

The separate clamped v11 sparse diagnostic is in
`dist/retained-v11-herdr-diagnostic`. Viewer main-thread samples now rank JSON
parse (12.65% self), native diff (12.17%) and native render update (6.33%);
reconcile is no longer a leading inclusive hotspot. Daemon samples identify
foreground discovery (16.90% inclusive), CWD refresh (8.64%), surface capture
(10.52%) and launcher-preview publication (8.26%). The publication frame at
compiled line 47472:17 is `launch_service.publish`: its children include
preview, request and history update. Its 36 self samples in JSON stringify
are launcher preview comparison work. `Server.publish` is the separate
compiled frame at 50492:10, with wake-viewer children; its telemetry totals
only 4.11 ms over the minute. Wire encoding is another distinct path.

The diagnostic records exactly 19,180 drains and 19,180 feeds, confirming that
the repeated empty read was removed. It captures 1,199 full native surfaces
(10.694 MB JSON); native decode now occurs only for these surfaces, with no
`native.info` calls. The viewer installs 235 KB of changed-row data across
1,199 receives, emits 777 chrome patches and uses only 33 full compositions.
These are boundary counts and overlapping wall spans, not additive CPU costs.


### V12 launcher publication component check

`dist/preview-v12-summary.json` compares the real `launch_service.publish` →
`Worker.request/list` path in separately frozen v11 and v12 source trees. Each
uses its archived source overlay and copied matching term/system libraries;
`component-manifest.json` records the exact inputs. The identical
`preview_costs.ts` harness keeps provider readings fresh and stubs only `pump`,
so account JSON stat/cache reads and five-second executable installation
refreshes remain included. Provider/network work and sleeps are excluded.
The clock advances 100 ms per poll; projected CPU is a component extrapolation,
not a measured whole-daemon percentage. The fixture contains complete model,
usage-window and history readings for four defaults, plus either zero or eight
additional accounts.

The eight verification cases each execute 120 polls: stable readings,
wire-equivalent source replacement every fifty polls, a real account metadata
change, and restored pending readings, each at both account counts. Both
versions produce identical queued JSON bytes and final preview hashes. Changes
and restored completion are still published. Diagnostic instrumentation is
removed before timing. Stable v11 serializes 960/2,880 Option objects per 120
polls; v12 serializes zero. Equivalent replacements require 24/72 v12 Option
serializations, preserving the fallback equality check.

Serial node0 order was v11→v12 and node1 reversed it, with identical eight-core
placement, memory node and per-task 1024/1024 utilization clamps. Every timed
case uses 500 warmup polls and five batches of 4,000 polls. All process CPU is
included, including runtime helpers; the batches are repeated observations,
not independent whole-process experiments. Maximum whole-run SMT sibling
load was 0–0.99%. Frequency remains diagnostic only.

| Case | V11 µs CPU/poll, node range | V12 µs CPU/poll, node range | Reduction |
| --- | ---: | ---: | ---: |
| Stable, four defaults | 106.9–109.9 | 20.5–21.2 | 80–81% |
| Equivalent replacement, four defaults | 89.2–94.3 | 23.4–23.5 | 74–75% |
| Stable, eight additional accounts | 230.6–236.6 | 17.7–19.3 | 92% |
| Equivalent replacement, eight additional accounts | 229.7–237.5 | 22.5–25.3 | 89–90% |

At ten polls per second, the zero-extra-account stable savings project to
0.086–0.089 CPU percentage points. This confirms the serialization mechanism
but cannot alone explain or close the whole-daemon gap. The eight-account
projection is 0.213–0.217 percentage points. No allocation rate is inferred from
RSS or retained heap. A first verification attempt incorrectly used the new
Preview.with method on the old plain-object list result; that failed harness
run remains preserved as `preview-v11-verify.log`. The compatible harness uses
fixture-only Object.assign cloning in both trees. All subsequent verification
and timed outputs are retained under `dist/preview-v{11,12}-*`.

The next whole-app v12 check is deliberately a single Corgi trial, not a new
Herdr pair. Frozen observer4-single adds only `--single-corgi` planning; the
whole-trial and measured-window SMT <2%, executable/native provenance,
all-thread clamps, cadence, output, and cleanup guards remain unchanged.
Comparisons against earlier whole-app ranges are directional only.


### V12 single clean sparse workload

`dist/retained-v12-sparse-single` preserves both attempts. The first was rejected
for 3.38% whole-trial and 4.73% timed-window SMT sibling load, with every product
quality/provenance check passing. The unchanged predeclared retry passed:
1.72% whole-trial and 0.231% timed-window sibling load, 57 verified all-thread
clamp snapshots, matching embedded DSOs/executables and clean shutdown.

At the same 16-agent, 132×47 matched geometry with animation/resources enabled,
120 seconds of streaming warmup and a 60-second sample, daemon CPU was 4.7166%
and viewer CPU 1.7167% (6.4333% combined). Pane progress was 20.002 Hz and visible
animation 12.668 Hz, with 5.33 KB/s viewer output. This is one clean Corgi trial;
there is no fresh Herdr measurement or paired performance claim. Earlier v11
means were 5.0833% daemon and 1.9250% viewer, so the result is directional evidence
for lower cost, pending repeated final comparisons.

Inner-window thread attribution is preserved in `thread-analysis.json`.
Daemon main-thread CPU was 2.86%, fd-ready 0.44%, resource worker 0.52%, JIT 0.25%,
heap helper 0.18% and scavenger 0.27%. Viewer main-thread CPU was 1.29%, JIT 0.13%,
heap helper 0.05% and scavenger 0.18%. Thread boundaries and transient-thread
coverage differ from the authoritative whole-process CPU window.


### V12 separate sparse diagnostic

`dist/retained-v12-herdr-diagnostic/diagnostic-summary.json` collects the raw
profile rankings, telemetry, build/library provenance and clean thread
comparison. Raw inputs have a separate SHA256 manifest. This node1 diagnostic
passed cleanup, embedded-library/executable checks, 57 all-thread clamp
snapshots and output quality, with 0.651% maximum whole-trial SMT sibling load.
Pane updates remained 20.002 Hz and visible animation 12.335 Hz. Profile and
telemetry overhead are present: diagnostic CPU (daemon 4.967%, viewer 2.150%) must
not replace the clean sample above. Although the harness records an initial
warmup setting, CPU_STREAM_ONLY skips the idle phase where it would be used;
actual execution is setup, 120 seconds streaming warmup, then 60 seconds sample.

The newly separated viewer spans show 5,546 preparation calls totaling 32.659ms,
5,546 maintenance calls totaling 22.400ms, and 2,010 acknowledgements totaling
5.653ms. Preparation averages 5.89µs per loop and acknowledgement 2.81µs per call.
These are wall spans, not CPU samples; their absolute budgets are small. The
viewer still spends most elapsed time waiting (59.231seconds). Other spans:
sync 531.836ms, compose 79.429ms, present 81.677ms, wire decode 63.499ms,
chrome patch 48.374ms, surface handling 40.342ms. Nested spans must not be added.

Of 402 sampled viewer main-thread stacks, 68 terminate in JSON.parse in the RPC
socket callback (16.9%), 54 in native diff (13.4%), 27 in updateRender (6.7%), 18 in
stringify (4.5%), 14 in writeAll (3.5%), and 11 in byteLength in that same RPC
callback (2.7%). Thirteen stringify samples are RPC request encoding. Inclusive
present is 19.2%, compose 17.7%, reuseComposition 11.2%, and Mirror.receive 10.2%;
these overlap. Main-thread samples cannot attribute runtime helper CPU or
prove an allocation rate.

Of 983 sampled daemon main-thread stacks, 76 terminate in readlinkSync (7.7%),
61 each in parse and readSync (6.2%), 52 in the native-call wrapper (5.3%), 50 in
fsyncSync (5.1%), 48 in stringify (4.9%), 45 in openSync (4.6%) and 36 in readBytes
(3.7%). Exact leaf contexts distinguish the mechanisms:

- 74 readlink samples follow processCwd → refreshCwdFrom → refreshCwd.
- 52 native-call and 43 parse samples follow terminal surface → viewer sync.
- 49 fsync samples follow atomicWrite → recovery save → collect.
- 37 readSync and 26 openSync samples follow processArgs → foreground inspection.
- 24 readSync, 15 openSync and 13 processJob samples follow foreground process-group inspection.
- 28 networkInterfaces samples follow the ports scan.

Foreground inspection totals 172 inclusive samples (17.5%), surface 117 (11.9%)
and recovery save 86 (8.7%). The complete stringify stack census, preserved in
`stringify-comparison.json`, changes from 131 v11 leaves to 48 v12 leaves. The
43 detectPane comparison and 36 launcher publish comparison leaves seen in v11
are absent from the v12 measured sample set. Remaining v12 serialization is
24 peer queue→sync, 8 sync, 7 recovery save, 3 native surface request, 2 inference
publication, 3 other tracker tick and 1 wake queue. This confirms the intended
mechanisms; sample differences are not precise saved-CPU estimates.

Telemetry records 19,637 CWD checks/84.830ms; 240 foreground scans/197.796ms;
3,870 agent detections/77.356ms; 1,199 native surface calls/125.420ms; and the
same 10.694MB at the native surface JSON boundary. Within that native span,
execute is 55.747ms, request encoding 4.465ms and JSON decoding 64.385ms. The
resource worker has 29 samples/293.617ms, including 179.899ms GPU and 85.024ms
inventory spans. Those include waits and nested work. Full surface transfer
and process/filesystem inspection remain larger opportunities than the new
viewer preparation/acknowledgement spans.

The separate clean runs show daemon main-thread CPU 3.212% v11 mean → 2.856% in
one v12 trial, while its resource worker stays 0.531% → 0.521% and JIT 0.236%
→ 0.252%. Viewer main changes 1.399% → 1.294%, JIT 0.219% → 0.134%, and heap helper
0.118% → 0.050%. Thus runtime variation accounts for part of the viewer's lower
whole-process result. These are directional comparisons of earlier two v11
runs against one v12 run, not a paired confidence estimate.
