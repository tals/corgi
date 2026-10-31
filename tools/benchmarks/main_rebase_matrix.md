# CPU matrix after rebasing on main

The [final comparison against unmodified main](main_baseline_comparison.md)
supersedes this candidate-only matrix. It measures the simpler implementation
after removing brittle UI caches, with all eight main/candidate pairs accepted.

All 16 requested cells have accepted observations. No preflight or rejected timing is included.

The effort is rebased onto main `815313769575425029472d24479334d741f90452`.
The measured production binary was built from `94b0afc`; subsequent commit
`9d160e1` changes only benchmark instrumentation. Its SHA-256 is
`c034e49052ae7aad6f466f59cd59ec7ab4dd356f196ba3a02c9e8cfaae1c6826`.
Main's Zig 0.17.0 and Ghostty 1.4 update, activity sections, stars, manager UI,
images and drag scrolling are preserved. The pre-rebase effort remains at
`backup/terminal-costs-before-main-20261030`.

| Agents | State | Attached daemon | Attached viewer | Detached daemon |
| ---: | --- | ---: | ---: | ---: |
| 4 | idle | 1.57% | 0.85% | 1.32% |
| 4 | streaming | 3.93% | 1.68% | 2.47% |
| 8 | idle | 1.70% | 1.07% | 1.50% |
| 8 | streaming | 4.85% | 1.77% | 3.55% |
| 32 | idle | 3.08% | 1.03% | 2.55% |
| 32 | streaming | 7.85% | 1.67% | 6.53% |
| 64 | idle | 5.12% | 1.67% | 4.52% |
| 64 | streaming † | 14.25% | 1.83% | 12.40% |

† NUMA 1, CPUs 104–111; all other cells use NUMA 0, CPUs 48–55.

[Exact values and per-cell evidence](../../dist/rebase-main-matrix-final-20261030/summary.json),
[full table with separate waited-child CPU](../../dist/rebase-main-matrix-final-20261030/summary.md).

CPU is percent of one core: 100% means one fully occupied core. These are
daemon and viewer **process** user-plus-system times, including every thread.
The detached viewer exited. Fixture providers and the observer are excluded.
Each cell is one accepted 60-second observation after 30 seconds of warmup,
not an estimate with a confidence interval. This measures the rebased build's
absolute workload cost; it is not a new main/Herdr optimization comparison.

## Workload and placement

Each case has N alternating Claude/Codex fixture providers and one quiet shell.
One first-agent pane is visible. The host is 160×48 cells and provider PTYs are
132×47. Idle providers remain at stable prompts. Streaming sends one sparse
row update per provider at 20 Hz, using a shared monotonic schedule and
staggered phases. Default animation intensity 50 and resource monitoring stay
enabled. Transcripts are minimal; real inference and full Codex app-server
polling are not exercised. The installed provider set can still affect
launcher-preview work. The project is an empty isolated non-Git directory;
this matrix does not exercise real repository/worktree/push scanning.

The machine has two AMD EPYC 7C13 sockets, 128 physical cores and 256 logical
CPUs. Each trial uses eight physical cores sharing one L3, with one hardware
thread selected per core and memory bound to their NUMA node. The observer is
on CPU 0. Descendant utilization clamps request min=max 1024. Application
benchmarks run serially under the shared benchmark lock. Our builds and tests
do not overlap measurements; read-only audits during measurements run on CPU 0.

The first 14 accepted cells use NUMA 0, CPUs 48–55 (siblings 176–183). Repeated
contention prevented completion of 64-agent streaming on that group. Two
prospective host-only pilots found no quiet alternative group on NUMA 0.
A subsequent three-minute pilot across both nodes selected NUMA 1, CPUs
104–111 (siblings 232–239), before any application measurement there. Its
worst whole-pilot/final-30-second mean was 0.467%. The final streaming case
uses that placement and memory bind 1. **This placement difference limits
comparisons of that case with the other counts and states.**

Every included trial must pass the original maximum 2% mean SMT-sibling load
limits, both over the complete trial and separately over each measured
window. At most three attempts are permitted per recorded case. Failed
runs and prospective placement pilots are preserved; no rejected timing is
rehabilitated. The user's preference to wait for quiet is retained.

Workload checks cover identities, state, geometry, actual producer writes,
cadence, visible pane/animation progress where applicable, executable/native
hashes and cleanup. Affinity receipts verify daemon/viewer leader masks;
archived per-thread CPU observations corroborate placement. Descendant
snapshots verify utilization clamps but do not record every child thread's
affinity. Linux inheritance is the intended placement, so these receipts
cannot certify the affinity of every fixture/Node child thread. Unrelated
process activity was also recorded on sibling CPUs, but the exact source of
each noise spike cannot be attributed from endpoint observations.

## Child-process accounting

The raw table reports daemon waited-child CPU separately. Attached samples
accrue approximately 0.65–0.80 percentage points; detached samples are close
to zero. Linux charges `cutime/cstime` when a child is reaped, so these values
can include work preceding the CPU window and are not a contemporaneous
subtree total. They are not silently added to daemon process CPU.

This charge cannot all be dismissed as startup: the accepted 8-agent idle
receipt observes a new Node child 22.98 seconds into the window, born 60.61
seconds after an earlier Node child. The attached launch preview's minute
refresh and Pi's RPC model query fit that timing ([preview](../../src/launch/preview.ts),
[Pi launcher](../../src/providers/pi/launcher.ts)). Attribution to Pi remains
an inference: child argv and individual child CPU were not archived.

## Correcting the idle guard

The original guard treated `/proc/PID/io` writes to any descriptor as terminal
output. One failed 64-agent idle trial crossed Bun's approximately 120-second
idle-GC threshold. Tracing two untouched fixture providers for 135 seconds
showed eight-byte eventfd wakes near 120.18 seconds and no terminal output
after their initial 26-byte prompts. The matching Bun 1.4.4 source identifies
the collector-to-event-loop wake path. The failed CPU trial remains excluded
for both its original guard failure and noise.

Benchmark-only instrumentation now counts explicit fixture terminal writes
at their write sites, verifies unchanged transcript metadata/content and
process identity, and retains stable-prompt checks. Counter receipts and
hashing run outside CPU windows. All-descriptor I/O remains diagnostic.
Tests show a real eight-byte eventfd write passes while an invisible
eight-byte terminal SGR write fails. Ordinary prompt bytes and controlled
streaming payloads are unchanged; small counter increments occur in the
excluded provider processes. Earlier accepted idle cells already passed the
stricter all-descriptor no-write guard. The product binary did not change.

The [trace receipt](../../dist/idle-write-audit-20261030/summary.json) also
records an invalid optional `/proc` sampler that selected a transient strace
helper. Those null readings are unused; syscall destination decoding and
captured stdout/stderr supply the direct evidence.

## Validation and evidence

- Unit tests: 2,213 passed, one skipped, zero failures.
- Integrations: 177 passed, two platform skips, zero failures across 11 suites.
- Native tests, typecheck/format, production/test builds and browser build pass.
- The corrected benchmark guard has eight passing focused tests; the Python
  runner/report has four passing tests. Typecheck passes after the guard fix.

[Validation manifest](../../dist/rebase-validation.json),
[guard tests](../../dist/rebase-idle-guard-tests.log),
[guard typecheck](../../dist/rebase-idle-guard-typecheck.log),
[runner tests](../../dist/rebase-matrix-report-tests.log),
[frozen product provenance](../../dist/rebase-main-provenance.json),
[independent audit](../../dist/rebase-main-audit-20261030/audit.md).

Primary source directories:

- [4/8/32 agents and original rejected 64-idle attempt](../../dist/rebase-main-matrix-node0-20261030/plan.json).
- [Accepted 64-idle and three rejected 64-streaming attempts](../../dist/rebase-main-matrix-64-20261030/plan.json).
- [Fresh run stopped by noisy preflights](../../dist/rebase-main-matrix-64-stream-20261030/plan.json).
- [Final 64-streaming placement and plan](../../dist/rebase-main-matrix-64-stream-node1-20261030/plan.json).

The earlier [NUMA 1 run](../../dist/rebase-main-matrix-20261030/plan.json)
is supplemental and excluded from the primary matrix. The final report links
each accepted cell to its original comparison receipt and source hashes.
