# Corgi / Herdr scaling, 2026-11-01

Baseline is main `e6e08abbcc98bfbbdce2c31c161f7414a89b1fe1`, fetched before
the experiment. Herdr is the pinned v0.9.5 binary used by the existing harness,
with source tag `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`; this is not a claim
about a newer Herdr release. The changes live in worktree
`/home/t/dev/personal/corgi-perf-herdr`, branch `perf/herdr-matrix-20261031`.

The first complete matrix shows 30–37% less combined CPU at 64 agents, with
essentially unchanged results at four agents. Busy, attached Corgi moves from
2.09× Herdr to 1.33× at 64 agents. Four-agent idle Corgi remains about 8× Herdr.
The viewer has a much larger ratio than the whole application: before these
changes, the busy viewer alone is about 14× Herdr at four agents and 26× at 64.
These measurements do not establish a universal 2× bound.

## Changes and mechanism

1. `Runtime.agentTargets` previously visited every pane for every tab, and each
   `tabForPane` call searched the tabs again. One pane per tab made this cubic.
   Grouping each pane once per call removes one loop while preserving tab order
   and runtime creation order within split tabs. `tabForPane` also stops copying
   the tab array for every lookup. There is no retained pane-to-tab index.
2. Agent navigation uses the existing sidebar target comparator. The hot pane
   and headless cases no longer allocate `Object.keys` arrays for equality.
3. The lower sidebar badge computes the farthest reachable row once. It no
   longer repeats the scroll-position search for every possible destination.
   The calculation includes pinned-header geometry and uses the original
   destination calculation for the selected agent.

There are no new persistent caches, revisions, invalidation rules, native
operations, protocol versions or saved-format changes. Defaults, animation
cadence, process observation freshness and recovery behavior remain intact.

The first daemon profile attributed roughly 55% of sampled main-thread stacks
in the 64-agent busy attached phase to `tabForPane`; the matched node-1 repeat
found 53.4%. After the first iteration,
the `daemon.publish` wall span fell from 5.424% to 0.459% of elapsed time in
matched diagnostic runs on node 0. These spans are nested wall measurements,
not additive CPU attribution. The second iteration addressed the viewer's
target comparisons and repeated pinned-header calculations.

## CPU matrix

Each cell is **daemon / viewer CPU**, in percent of one core. A dash means no
viewer. Total ratios include both processes while attached. All daemon/viewer
threads count; provider and harness processes do not. Waited-child CPU is
recorded separately in the evidence and is not added to these process totals.

| Agents | State | Viewer | Main D / V | Candidate D / V | Herdr D / V | Total reduction | Candidate / Herdr |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 4 | Idle | Attached | 1.93 / 1.43 | 1.93 / 1.57 | 0.27 / 0.17 | −4.0% | 8.08× |
| 4 | Idle | Detached | 1.23 / — | 1.23 / — | 0.27 / — | 0.0% | 4.63× |
| 4 | Busy | Attached | 4.17 / 3.27 | 4.00 / 3.20 | 1.47 / 0.23 | 3.1% | 4.24× |
| 4 | Busy | Detached | 2.90 / — | 2.90 / — | 1.17 / — | 0.0% | 2.49× |
| 64 | Idle | Attached | 5.47 / 2.43 | 3.63 / 1.93 | 1.93 / 0.13 | 29.5% | 2.69× |
| 64 | Idle | Detached | 4.73 / — | 3.03 / — | 2.03 / — | 35.9% | 1.49× |
| 64 | Busy | Attached | 18.77 / 5.23 | 11.20 / 4.03 | 11.27 / 0.20 | 36.5% | 1.33× |
| 64 | Busy | Detached | 14.76 / — | 9.83 / — | 11.53 / — | 33.4% | 0.85× |

Busy 64-agent attached samples additionally report 1.47 CPU points of
waited-child accounting for both Corgi builds, versus zero for Herdr. A rough
sum would be 25.47% → 16.70%, a 34.4% reduction and 1.46× Herdr. This is not
a synchronized process-tree measurement: Linux charges exited children's
accumulated CPU when they are reaped, which can cross the sampling boundary.
Every other cell reports at most 0.033 points of waited-child CPU.

The four-agent differences are too small and noisy to claim an improvement or
regression. All six 64-agent executions passed both workload checks and the
original strict noise guards. Nine of the twelve matrix executions passed the
strict guards overall; the exceptions are four-agent idle Herdr, idle candidate,
and busy candidate. They remain visibly flagged in the evidence.

## Longer repeats

Fresh processes repeated four-agent idle and 64-agent busy cases with 30-second
warmups and 60-second samples, reversing the original order to candidate →
Herdr → main. These are separate observations, not pooled with the shorter
matrix or presented as a confidence interval.

| Agents | State / attachment | Main D / V | Candidate D / V | Herdr D / V | Total reduction | Candidate / Herdr |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 4 | Idle attached | 1.68 / 1.47 | 1.63 / 1.28 | 0.23 / 0.15 | 7.4% | 7.61× |
| 4 | Idle detached | 1.47 / — | 1.32 / — | 0.22 / — | 10.2% | 6.08× |
| 64 | Busy attached | 18.35 / 5.05 | 11.17 / 3.88 | 10.92 / 0.17 | 35.7% | 1.36× |
| 64 | Busy detached | 14.50 / — | 9.66 / — | 10.96 / — | 33.3% | 0.88× |

The large-agent reduction repeats closely. Small-agent observations still
overlap the earlier variability and leave a large Herdr gap. All workload
checks passed. Both Herdr trials and the 64-agent candidate passed strict
noise guards; the other three trials retain their flags. Measured-window
sibling load crossed 2% for four-agent candidate attached (2.231%), four-agent
main detached (3.045%), and 64-agent main detached (2.287%).

Waited-child accounting adds 0.733 points to both four-agent attached Corgi
samples and 0.800 points to both 64-agent attached Corgi samples, versus zero
for Herdr. Detached charges are at most 0.033 points. These charges should
not all be dismissed as startup; the earlier
[child-process accounting investigation](main_rebase_matrix.md#child-process-accounting)
observed recurring attached work, although exact attribution was unresolved.
The CPU tables consistently report process totals and retain child charges
separately.

## Measurement contract

The existing `cost_matrix.py`, `cpu.ts` and `cost_matrix_herdr.ts` harnesses ran
serially. All binaries were frozen before measurement. Bun is 1.4.4; both Corgi
builds embed the same native assets. Defaults stayed enabled: decoration
intensity 50 and resource readings on. The host has two EPYC 7C13 CPUs and two
RTX 6000 Ada GPUs.

The workload is four or 64 alternating fake Claude/Codex agents plus a quiet
shell in one non-Git workspace. One agent pane is visible. Busy agents each
emit one sparse row at 20 Hz, staggered from a shared epoch. Inner PTYs are
132×47 for both products; outer viewers are 160×48 Corgi and 159×48 Herdr.
Idle and busy cases start fresh processes. Each case samples attached and then
detached operation for 30 seconds after 15 seconds of warmup per phase.

Application processes and descendants use CPUs 88–95 on NUMA node 1, with
memory bound to that node and all-thread utilization clamps fixed at 1024.
The observer runs on CPU 0 with natural clamps. Application trials and
profiling runs are serialized; this investigation's builds and tests stay
outside their measurement windows. The shared host can have unrelated work.
Frequency observations are diagnostics, not a normalization of results.

A strict initial attempt on node 0 exhausted three noise retries. A second
host-only placement pilot found no group below the 2% SMT-sibling threshold.
The new matrix therefore prospectively retained the first functionally valid
trial regardless of noise, preserving all original strict flags. Earlier
rejected trials were not reclassified. An earlier long-output-path Herdr setup
failure is also excluded. Raw failures remain available locally.

The four-agent idle candidate's first detached phase overlapped moving the
workspace at the user's request; this trial already failed the strict noise
guard. The longer repeat starts entirely in the isolated worktree. Short
samples, shared-host interference and runtime warmup limit precision; this is
an observational comparison, with no confidence interval or steady-state
convergence claim.

The harness verifies identities, activity state, terminal geometry, producer
writes, visible progress, display cadence, executable/native identity and
cleanup. Cadence checks run outside CPU windows and require over 12 visible
changes/s with no observed gap above 250 ms. These checks detect stalled or
batched output; they are not input-latency measurements. The fixtures exclude
model calls, rich transcript histories, Git-heavy workspaces and bound Codex
app-server polling. Setup, builds and downloads are outside the measurements.

## Memory

Attached PSS snapshots, **daemon / viewer MiB**, taken outside CPU windows:

| Agents | State | Main | Candidate | Herdr |
| ---: | --- | ---: | ---: | ---: |
| 4 | Idle | 81.4 / 58.8 | 79.2 / 58.8 | 18.5 / 8.9 |
| 4 | Busy | 83.1 / 60.1 | 81.7 / 64.3 | 18.6 / 9.0 |
| 64 | Idle | 117.0 / 66.0 | 116.5 / 66.2 | 41.2 / 9.4 |
| 64 | Busy | 139.8 / 69.3 | 125.1 / 71.5 | 26.5 / 9.4 |

The small-agent memory gap remains about 5×. The lower daemon PSS in one busy
64-agent candidate observation does not establish a memory or leak fix. PSS
also changes when the viewer exits and mapped file pages cease to be shared;
the evidence retains separate attached/detached PSS and RSS snapshots.

## Telemetry breakdown

Separate profiling runs cover every matrix cell for both main and candidate,
on the same node-1 placement, with 10-second warmups and 20-second samples.
Each profiling process runs idle attached, busy attached, busy detached, then
idle detached; that final idle phase follows activity rather than a fresh start.
These runs enable both Bun profiling and telemetry and use natural utilization
clamps; their process CPU is not used in the unprofiled comparison.
Bun stack shares count samples, not the
large `timeDeltas` that include event-loop idle time. They cover the main
thread and do not attribute JIT, GC or resource-worker CPU.

Values below are **main → candidate percent of elapsed wall time**. Spans
overlap and include waits/descheduling, so neither rows nor columns form an
additive CPU breakdown. `collect` includes observer, publication and recovery
work. Resource sampling runs on a separate worker.

| Agents | State / attachment | Collect | Publish | Observers | Resource sample |
| ---: | --- | ---: | ---: | ---: | ---: |
| 4 | Idle attached | 0.533 → 0.565 | 0.006 → 0.005 | 0.202 → 0.210 | 0.482 → 0.485 |
| 4 | Idle detached | 0.390 → 0.389 | 0.001 → 0.001 | 0.159 → 0.163 | 0.462 → 0.457 |
| 4 | Busy attached | 1.694 → 1.855 | 0.101 → 0.101 | 0.348 → 0.344 | 0.454 → 0.449 |
| 4 | Busy detached | 1.971 → 1.233 | 0.032 → 0.032 | 0.321 → 0.319 | 0.469 → 0.417 |
| 64 | Idle attached | 1.591 → 0.950 | 0.077 → 0.008 | 0.432 → 0.407 | 0.850 → 0.878 |
| 64 | Idle detached | 1.530 → 0.876 | 0.067 → 0.006 | 0.420 → 0.394 | 0.892 → 0.881 |
| 64 | Busy attached | 7.994 → 4.075 | 4.570 → 0.468 | 1.718 → 1.746 | 0.877 → 0.899 |
| 64 | Busy detached | 8.426 → 3.670 | 2.176 → 0.186 | 1.709 → 1.629 | 1.036 → 1.072 |

| Agents | Attached state | Viewer compose | Viewer present |
| ---: | --- | ---: | ---: |
| 4 | Idle | 0.555 → 0.619 | 0.121 → 0.125 |
| 4 | Busy | 0.865 → 0.863 | 0.573 → 0.524 |
| 64 | Idle | 0.730 → 0.571 | 0.082 → 0.092 |
| 64 | Busy | 1.805 → 1.225 | 0.495 → 0.518 |

At 64 busy agents, PTY drains remain about 1,280/s; their attached wall span is
0.977 → 1.006%. CWD observation remains about 1,311/s and 0.682 → 0.664%.
Foreground observation runs about four passes/s and agent detection about
256/s. Resource inventory takes about 0.52% elapsed and GPU queries 0.31%
in the candidate's attached sample. The viewer composes/presents around
20.5 times/s. These costs were preserved, not hidden by lowering cadence.

Recovery spans vary with storage waits: the four-agent detached busy span
alone changes 1.227 → 0.490%, accounting for almost all of that cell's
`collect` difference despite unchanged process CPU. It is not an optimization
claim. Full per-cell call rates, byte counters and wall spans are in the
portable evidence.

## Remaining work and evidence

Thread observations from the unprofiled 64-agent busy attached runs support
the mechanism. Approximate CPU points on the daemon main thread fell
13.09 → 6.92, and heap-helper threads fell 1.56 → 0.41. Readiness-thread CPU
was essentially unchanged, 1.35 → 1.36. Viewer main-thread CPU fell
3.22 → 2.54. Thread totals use inner half-second sample boundaries and can
miss short-lived threads; the process totals above use their own exact window.

The smaller scene is dominated by costs that the scaling fixes do not remove:
UI composition and terminal presentation, runtime helper threads, and recurring
resource/process observation. In the four-agent candidate's separate busy
profile, viewer composition took 0.863% of elapsed time and presentation 0.524%,
at about 20.6 calls/s. The resource worker's sample span was 0.449%, including
0.313% in GPU queries. The pinned Herdr has no equivalent host/GPU sampler.
These are wall spans, not parts to sum into a CPU total.

Unprofiled four-agent busy thread samples separately observed about 2.14 CPU
points on the viewer main thread, 0.61 in JIT workers and 0.34 in heap/scavenger
helpers. The daemon resource worker accounted for about 0.44 CPU points.
JIT work in these windows is observed runtime work, not proof of a permanent
steady-state maintenance cost.

Corgi and Herdr also buy different process/CWD freshness and recovery behavior;
see the [recurring-work source audit](herdr_recurring_work.md). Lowering those
cadences or adding PID/CWD caches would change behavior. The
[GPU sampling audit](gpu_sampling_audit.md) explains why skipping seemingly
idle GPU queries can change attribution history. Those are not equivalent
optimizations to adopt just to improve this table.

The [portable evidence](evidence/herdr-scaling-20261101/summary.json) records
measurements and provenance. Full binaries, source patches, profiles,
telemetry snapshots and experiment scripts live in
[the local artifact directory](../../dist/perf-herdr-20261031/);
raw CPU trials are archived there as `matrix-raw/` and `repeat-raw/`, alongside
the earlier rejected strict attempts. Original `/tmp/ch2` and `/tmp/ch3` paths
remain in raw receipts. Only leftover Unix socket inodes were excluded from
the archive; their names are recorded in `archive-skipped-sockets.json`.

Frozen production binary SHA-256 values:

| Build | SHA-256 |
| --- | --- |
| Main | `105ebbb9eac17e13a2cd408dd537acd1132dd8e5ed36f7f20682b475aa3540b8` |
| Candidate | `6ee030dd27f4629139d12bc8587323ec107c883aecea04b9597c2353b1577f1d` |
| Herdr v0.9.5 | `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d` |

The local `matrix.py` and `repeat.py` scripts record the complete execution
order. A single main/Herdr case is reproducible with the existing harness:

```sh
python3 tools/benchmarks/cost_matrix.py /absolute/main /absolute/herdr /tmp/ch-new \
  --agents 64 --workload busy --stream-mode sparse --producer-phase staggered \
  --match-geometry --node 1 --cpus 88,89,90,91,92,93,94,95 --uclamp \
  --diagnostic-frequency --noise-diagnostic --seconds 30 \
  --warmup 15 --initial-warmup 15 --order corgi-first
```

Use a new short output directory for every attempt and retain the matching
`.build.json` beside each Corgi binary. Repeat with the candidate and
`--single-corgi`, or reverse the pair order. Select placement prospectively
on another host; these CPU numbers do not imply this placement will stay quiet.

## Validation

- Full `bun test src`: **2,330 pass, one opt-in skip, zero failures**.
- Typecheck/format and production/test builds passed. Measured, rebuilt
  production and test binaries have identical source and native-asset hashes.
- Browser build passed after installing an isolated `happy-dom` 21.0.4
  dependency tree in the worktree. The initial environment was missing its
  `buffer-image-size` dependency; no project dependency declarations changed.
- `agent_reorder`, `agent_pins`, `viewer_sync`, `selection`, `reloads` and
  `smoke_terminal` passed in both serial integration runs. The `viewers` suite
  passed an isolated serial run (33 pass, one platform skip), but both full
  runs timed out in `test_workspace_away_usage_resets_on_visit_and_respects_other_viewers`
  at `tests/viewers.test.ts:641`. An unchanged-main test build reproduced that
  exact timeout on its first isolated attempt. Its source/native hashes match
  the frozen baseline. This existing failure remains unresolved; neither the
  test nor accounting behavior was changed to make the run green.
- Existing badge tests passed, and a seeded differential harness compared
  both badge directions at three offsets in 2,500 generated worlds:
  **15,000 comparisons matched main**, including headings, worktrees, ghosts,
  focus, drawers and varying heights.
- All **19 real-PTY screenshot states** match main in styled cells, hyperlink
  destinations, cursor, decoded image placements/pixels and PNG hashes.
  Selection during output, split panes and a dimmed dialog were also inspected.
  The local rasterizer lacks the `⧉` glyph on both sides; the styled-cell
  comparison still checks its codepoint. Opaque image/link IDs are excluded.
- All 18 matrix/repeat executions passed workload and cleanup checks.
  Candidate visible progress and cadence remained about 20 Hz; its largest
  observed cadence gap was 51.2 ms. These are throughput guards, not input
  latency measurements.

The [validation receipt](evidence/herdr-scaling-20261101/validation.json)
retains successful and failed commands, the baseline failure, differential
checks, visual comparisons and build provenance. Full logs remain in the
local artifact directory.
