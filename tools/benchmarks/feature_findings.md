# Optional feature attribution, V14

This is a supported-preference attribution, not a Herdr comparison. The same
frozen Corgi V14 binary ran with defaults (decoration intensity 50, resources on)
and with intensity 0/resources off. Zero intensity removes decorative corgis;
informative working spinners still run. Disabling both features together does
not identify their individual costs or interaction.

The prospectively fixed order was default → quiet → quiet → default on NUMA
node 0, CPUs 8–15, one thread from each of eight physical cores in one L3.
Each fresh process had 120 seconds of streaming warmup and a 60-second sample,
16 fake agents plus the initial shell, 20 Hz sparse updates, and a verified
132×47 terminal surface. Both settings used the same all-thread utilization
clamps, quality checks, embedded native verification and strict whole-trial and
measured-window SMT mean limits below 2%. Reported frequency is diagnostic only.

The block is **incomplete**. The final default position exhausted its three
predeclared noise retries. All three failed both whole-trial and measured-window
SMT guards. They remain excluded, no further retries ran, and there is no
post-block calibration or balanced contrast. The following accepted samples are
descriptive; they do not support a confidence interval or a default-parity claim.

| Accepted trial | Daemon CPU | Viewer CPU | Combined CPU |
| --- | ---: | ---: | ---: |
| First default | 4.900% | 1.667% | 6.567% |
| First quiet | 3.633% | 1.450% | 5.083% |
| Second quiet | 3.683% | 1.483% | 5.167% |

CPU is percent of one core. The quiet observations are 1.400–1.483 percentage
points below the single accepted default observation; this is not a completed
balanced estimate. All terminal and activity checks passed: visible pane updates
were 20.003–20.006 Hz and working spinners 12.335–12.670 Hz. Quiet samples kept
all decorative detail rows blank and showed no resource labels; resource
snapshots remained empty with timestamp zero. Default resource timestamps
advanced. These extra checks run outside the CPU window.

Thread attribution supports one concrete mechanism: the daemon resource Worker
consumed about 0.52 CPU percentage points in the accepted default run and was
absent in both quiet runs. Daemon main CPU was 2.96% versus 2.59–2.63%, while
viewer main CPU was 1.28% versus 1.14% in both quiet runs. Reporter CPU also
varied, 0.59% versus 0.39–0.40%; do not assign every thread difference causally
to the feature controls from this incomplete block. Process user/system CPU
was 2.450/2.450% for the default daemon versus 2.017–2.083/1.600–1.617% quiet;
viewer user CPU was 1.333% versus 1.133–1.150%, with system CPU approximately
0.32–0.33% throughout.

| Rejected final-default attempt | Whole-trial maximum sibling mean | Measured-window maximum sibling mean |
| --- | ---: | ---: |
| 1 | 5.507% | 8.771% |
| 2 | 6.964% | 9.940% |
| 3 | 2.711% | 2.919% |

The three accepted whole-trial sibling maxima were 0.325%, 0.303% and 1.891%;
measured-window maxima were 0.315%, 0.281% and 0.150%. Every execution completed
quality/native/settings checks and cleaned up; only interference prevented
completion. Future placement can be selected prospectively from host-only load
observations, but these rejected results must not be relabelled.

## Reproduction and preserved evidence

- Frozen binary: `dist/corgi-retained-v14`, SHA-256
  `b1cedd6fd495d346f8ece88d52df886b6b958e5d3f0f8b065dc32f444b5bfd97`.
- Frozen observer: `/tmp/v6-harness-frozen-observer6-features`.
- Raw trials, configuration, per-half-second process/thread observations and all
  rejections: `dist/retained-v14-feature-attribution/`.
- Concise extraction: `attribution-summary.json`; accepted thread extraction:
  `accepted-threads.json`; executed overlay copies: `harness/`; file checksums:
  `artifact-manifest.json` within that output directory.
- Overlay receipt: `dist/feature-attribution-overlay.json`.
- Initial harness copy error was preserved in
  `dist/feature-attribution-initial-feature_cpu.ts.fixture`, initial typecheck
  log and `dist/feature-attribution-quiet-smoke/`. The corrected 2-agent smoke
  is `dist/feature-attribution-quiet-smoke-retry1/`; it is correctness evidence,
  not a performance result. Formatting and the tools typecheck passed before
  the full block. No production code changed for this experiment.

Run from the frozen observer root:

```sh
env -u CORGI_NATIVE_ROOT -u BUN_OPTIONS \
  python3 tools/benchmarks/feature_costs.py \
  /home/t/dev/personal/corgi-terminal-costs-20261025/dist/corgi-retained-v14 \
  /path/to/fresh-output --scenario sparse --node 0
```
