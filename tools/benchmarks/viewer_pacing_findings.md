# V15 pacing-reply experiment

The clean default-feature V14/V15 block did not demonstrate a viewer CPU uplift.
All four fresh trials passed the prospectively declared guards on their first
attempt; the CPU ranges overlap. Combined CPU was higher in the V15 observations.
This is an implementation comparison, not evidence of parity with Herdr.

| CPU, percent of one core | V14 mean (range) | V15 mean (range) |
| --- | ---: | ---: |
| Daemon | 4.500 (4.483–4.517) | 4.958 (4.950–4.967) |
| Viewer | 1.675 (1.667–1.683) | 1.667 (1.633–1.700) |
| Combined | 6.175 (6.150–6.200) | 6.625 (6.583–6.667) |

The viewer difference is only 0.0083 percentage points, approximately 0.5%.
One balanced block is one independent contrast; two observations per version do
not provide a useful confidence interval. The V15 source manifest records only
viewer pacing and telemetry changes from V14, with identical native assets.
A separate aggregate-counter run can verify reduced unnecessary loop work; such
counts are not CPU attribution and have not been measured by this block.

The order was V14 → V15 → V15 → V14. Each fresh trial used 16 fake agents plus
the shell, 20 Hz sparse updates, a matched 132×47 pane, 120 seconds of streaming
warmup and 60 seconds sampled. Decoration intensity 50 and resource sampling
remained enabled. A preceding host-only 60-second pilot selected NUMA node 0,
CPUs 16–23 in L3 2, with SMT siblings 144–151 and observer CPU 0. Selection used
no V14/V15 application outcomes.

Whole-trial maximum sibling means were 0.295%, 0.626%, 0.902% and 0.349%; the
measured-window maxima were 0.416%, 1.119%, 0.921% and 0.318%. All were below the
fixed 2% limit. Before/after calibration was valid, with maximum drift 5.25%,
below its predeclared 10% flag. Frequencies remain diagnostic only. Executable
hashes, four-asset native aggregates, affinity, utilization clamps, settings,
geometry, output progression and cleanup all passed. Visible pane progress was
20.001–20.002 Hz; spinner updates were 12.334–12.668 Hz.

The daemon reporter thread varied from 0.38–0.45% in V14 to 0.54–0.59% in V15;
daemon main CPU varied from 2.70–2.71% to 2.97–3.04%. Viewer main ranges were
1.23–1.29% and 1.24–1.26%, respectively. Source review found that the fixture's
sixteen independent interval timers have uncontrolled relative phase. That is a
plausible nuisance for daemon batching costs, not a measured explanation of this
particular CPU difference. See [producer phase audit](producer_phase_findings.md).
These trials remain accepted under their original protocol; no result is
retroactively rejected or reclassified.

Raw evidence is in `dist/retained-v15-v14-sparse-node0/`: `comparison.json`,
`comparison-summary.json`, `threads-summary.json`, each trial's output and
half-second observations, `harness/`, and `artifact-manifest.json`. The preceding
pilot is `dist/corgi-v15-placement-pilot.json`; frozen observer provenance is
`dist/corgi-v15-observer7-frozen-receipt.json`. The same-binary correctness
preflight passed four trials before timing and remains separately preserved in
`dist/corgi-v15-coordinator-preflight/`.
