# CPU comparison

Build both revisions before measuring. Run the same harness and fake-provider
workload serially; `flock` prevents overlapping Corgi benchmark runs. Each run
owns its home, socket and processes. No model calls or existing sessions are used.

The [2026-11-01 Herdr scaling investigation](herdr_scaling_findings.md) covers
4/64 agents, idle/busy and attached/detached operation, with daemon/viewer CPU,
memory, thread attribution and telemetry before and after the scaling fixes.

```sh
CPU_MATRIX_ONLY=1 CPU_AGENTS=8 CPU_INITIAL_WARMUP_SECONDS=20 CPU_WARMUP_SECONDS=5 \
  bun tools/benchmarks/cpu.ts /absolute/path/to/corgi /tmp/fresh-results 15
```

Repeat for both binaries, reversing their order on the second run; also run
`CPU_AGENTS=32`. On a shared Linux host, use the same physical cores and NUMA
node for each matched pair, e.g. `numactl --physcpubind=8-15 --membind=0 bun …`.
Keep builds, tests and other benchmarks outside measurement windows.

The four phases are idle attached, streaming attached, streaming detached and
idle detached. A 160×48 viewer shows one of N alternating Claude/Codex agents,
plus a quiet shell. Each streaming agent requests one roughly 130-byte line
at 20 Hz. CPU includes all daemon/viewer threads; 100% is one core. Provider
and harness CPU are excluded. Compare daemon plus viewer while attached.

The harness checks agent identities/state, visible sequence progress and source
lag, then separately probes visible update cadence for three seconds. Cadence
must exceed 12 changes/s with no observed gap above 250 ms. These checks detect
stalled/batched output; they do not measure input latency. Noisy hosts can still
affect results. Codex fixtures are screen-tracked and exclude bound app-server
polling; transcripts are minimal. Work scales with owned processes and panes,
and streaming with emitted bytes. Results are CPU savings for this workload,
not model throughput or a universal speedup.

`results.json` preserves the samples and cadence trace. Each phase saves its
snapshot and attached screen; `cleanup.json` confirms normal teardown. Failed
runs keep terminal output in `failure.txt` and still clean up owned processes.
`CPU_PROFILE=1` is available for separate profiling runs; never mix those with
CPU comparisons. `CPU_MATRIX_ONLY` omitted also measures startup/working phases.

## Commit review

The baseline is `f7f8e6d`: today's upstream main, including the five published
fixes and none of the performance batch. Original history is preserved locally
at `backup/main-before-perf-trim-20261025`.

| Original | Decision | Reason |
| --- | --- | --- |
| `61e62e0` | Keep application changes | Avoid repeated discovery, process inspection, snapshots and row rendering; bounded caches and existing sprite cadence. |
| `6c555a9` | Keep application changes | Cheap URL-prefix test avoids unnecessary byte-to-cell maps. |
| `ad06ffc` | Keep | Build tab groups once per frame; no persistent cache. |
| `9fe957e` | Drop | Herdr comparison and historical data are experiments, not product fixes. |
| `42a1b0d` | Keep | Filter irrelevant processes before reading descriptors. |
| `58762f6` | Keep | Reuse counters from the same fresh process inventory. |
| `95c552f` | Keep | Read a current terminal title identity once per observation. |
| `a105198` | Keep | Local maps replace repeated membership scans. |
| `627255c` | Keep | Check EOF metadata before reopening; retain rotation and symlink checks. |
| `8557cc6` | Drop | Ablation patches, runner and raw history are diagnostic experiments. |
| `7036cc1` | Drop | Cross-product NUMA framework and large historical results need not ship. |
| `7c0a769` | Drop | Separate resource revisions and native retained-cell presentation add another rendering path. |
| `839cda9` | Keep | Reuse authoritative rows with the existing native fallback for selection/clipping. |
| `5db424c` | Simplify | Keep benchmark locking and visible-progress checks in one workload. |
| `1ddb0b6` | Drop | Frozen-revision build/matrix orchestration is unnecessary for routine comparisons. |
| `039e196` | Drop | Retained pane geometry and fallback rules multiply rendering states. |
| `f2d0be0` | Keep in harness | Cadence checks prevent claiming savings from frozen or batched output. |
| `c0a398e` | Keep in harness | Use the existing protocol-negotiating CLI for pane reads. |
| `100fd68` | Drop | Lazy native mirrors introduce deferred/exposed state and materialization rules. |
| `1172b9e` | Simplify | Keep failure output and normal cleanup; remove the diagnostics/manifest framework. |
| `cf58cd9` | Drop | Retained animation rows add another rendering path and maintenance scheduler. |
| `eeb7318` | Drop | Test adjustment belongs to the removed resource presentation path. |
| `a954a5f` | Park | Long-plan eval experiment is unrelated; preserved on the backup branch. |
| `f7e3e76` | Published | Codex rename transport fix. |
| `2f6b97e` | Published | Fork agents in their tracked worktree. |
| `14fe296` | Published | Fold tests in mixed review diffs. |
| `6a1d07f` | Published as `53275dc` | Kitty badge flicker fix. |
| `4dd987c` | Published as `f7f8e6d` | Kitty badge proportions fix. |
| `7c255d4` | Drop | Integration merge is replaced by a linear branch over upstream. |

## Verification

Application commit `ef3d335`, compared with upstream `f7f8e6d` using the same
harness and production binaries. Two samples per cell, one on each NUMA node;
15-second samples after 20 seconds initial warmup and 5 seconds between phases.
Baseline/candidate order reverses between placements. CPUs 8–15/node 0 and
72–79/node 1 are bound with `numactl`; builds and tests finish before timing.
The shared benchmark lock spans the comparison. No initial downloads or builds
are included. These are steady-workload CPU measurements, not startup timings.

| Agents | Phase | Baseline CPU | Reduced CPU | Baseline / reduced |
| ---: | --- | ---: | ---: | ---: |
| 8 | Idle, attached | 11.83% | 5.47% | 2.16× |
| 8 | Streaming, attached | 29.80% | 18.40% | 1.62× |
| 8 | Streaming, detached | 9.69% | 6.86% | 1.41× |
| 8 | Idle, detached | 3.46% | 2.20% | 1.58× |
| 32 | Idle, attached | 17.96% | 7.66% | 2.34× |
| 32 | Streaming, attached | 55.27% | 26.87% | 2.06× |
| 32 | Streaming, detached | 34.86% | 14.83% | 2.35× |
| 32 | Idle, detached | 6.99% | 3.60% | 1.94× |

CPU is daemon + viewer while attached, daemon alone while detached. Values
are means of the two matched samples. The reduced version achieves about 2×
lower CPU for the 32-agent active workload and idle attached scenes. The
8-agent streaming gain is smaller; this is not a universal 2× speedup.

All eight runs passed identity, progress, cadence and cleanup checks. Visible
throughput ranged from 19.93 to 20.00 lines/s.
Candidate cadence was 19.67–20.00 distinct changes/s; its worst observed gap
was 101.7 ms. Source reads led visible receipts by at most 2 lines.
The source read happens later, outside timing; this is not input latency.
No attempts were rejected. Maximum external SMT-sibling load averaged over a
whole trial was 5.6% (10% rejection threshold). Whole-trial averages do not
exclude short disturbances; two samples on a shared host are estimates.

Validation: production/test builds, typecheck/format, 1,756 unit/harness tests
(one opt-in skip), and `links`, `viewer_sync`, `viewers`, `agent_reorder`,
`selection`, `reloads`, `smoke_terminal` integrations passed. Optional site
checks fail on both this branch and unchanged upstream: the build has missing
`happy-dom` dependencies, and frame replay hits an undefined Git diff fixture.
Those pre-existing failures are not included in the passing checks.

The production diff is 296 changed lines versus 1,436 in the original batch
(tests excluded). Experimental data, alternative runners and the eval prototype
remain on the preserved branch, outside main.

[Local raw samples and binary provenance](../../dist/perf-review-20261025/comparison.json)
include both repetitions, terminal snapshots, cadence traces and cleanup records.
The local artifact directory is ignored; historical benchmark dumps are not
committed. `runner.py` in that directory records this comparison schedule.
