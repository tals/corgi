# V18 viewer heartbeat and mirror eviction

The combined V18 candidate did not establish lower daemon-plus-viewer CPU. It
used consistently less viewer memory in this block. The candidate combines a
conservative 75 ms ordinary-view wait cap with eviction of hidden native mirror
surfaces; the CPU comparison does not isolate either change. This is not a
comparison with Herdr.

| Metric | V15 mean (range) | V18 mean (range) |
| --- | ---: | ---: |
| Daemon CPU, percent of one core | 4.192 (4.150–4.233) | 4.292 (4.233–4.350) |
| Viewer CPU, percent of one core | 1.792 (1.767–1.817) | 1.717 (1.700–1.733) |
| Combined CPU, percent of one core | 5.983 (5.967–6.000) | 6.008 (5.933–6.083) |
| Viewer PSS, MiB | 67.87 (67.48–68.26) | 59.80 (59.36–60.24) |
| Viewer median RSS, MiB | 86.45 (86.33–86.57) | 78.23 (78.21–78.25) |

Viewer CPU decreased by 0.075 percentage points (4.2%), while combined CPU
increased by 0.025 points (0.4%). Viewer PSS decreased by 8.07 MiB (11.9%).
PSS was sampled once after each CPU window; RSS was observed during it. One
balanced block is one independent contrast, with two fresh processes per binary;
these ranges do not establish a confidence interval.

Before/after SHA-256 calibration flagged environmental drift: throughput rose
1.30–13.03% across the selected cores, and five of eight exceeded the predeclared
10% flag. This was prospectively a review flag, not automatic rejection or a
normalization factor. The small CPU differences deserve particular caution.

Sampled viewer main-thread CPU decreased from 1.335% to 1.163%, but viewer JIT
work rose from 0.084% to 0.219%, offsetting much of that reduction. Daemon main
and readiness threads were approximately flat (2.569%/0.269% versus
2.579%/0.270%); daemon JIT and heap-helper work were higher in the candidate
observations. Thread summaries use inner half-second sample boundaries and may
miss transient thread work. They describe observed work, not a proof of steady
maintenance cost or attribution of the wait cap alone.

The predeclared order was V15 → V18 → V18 → V15, using the frozen observer9
harness. All four trials passed on their first attempt. Each used 16 providers
plus the initial shell, shared absolute 20 Hz aligned sparse writes, matched
132×47 pane geometry, 120 seconds streaming warmup and 60 seconds sampled.
Default decoration intensity 50 and resource sampling remained enabled. A
60-second host-only pilot selected NUMA node 0, CPUs 24–31, L3 3, with SMT
siblings 152–159 and observer CPU 0. No application outcomes entered that
selection. The pilot explicitly recorded separately pinned validation/build
work on node 1 CPUs 64–71; no other build/test workload ran during the ABBA block.

Whole-trial busiest sibling means were 0.414%, 0.451%, 0.331% and 0.269%;
measured-window maxima were 0.467%, 1.215%, 0.538% and 0.298%, all below the
fixed 2% limit. Each trial verified all 19,168 interior producer writes with
zero drops. Worst per-lane p99 lateness was at most 1.471 ms. Pane progress
remained 20.00 Hz and visible animation 12.33–12.67 Hz. Executable and native
asset identities, utilization clamps, affinity, settings, geometry, output
progression and cleanup passed. Frequency remains diagnostic only.

An earlier V17-only block on CPUs 40–47 stopped after three rejected V15
attempts; V17 was never measured. All three failed the unchanged whole-trial
and measured-window SMT guards. Those attempts remain excluded and preserved.
Before any trial on the newly selected placement, the scope was explicitly
changed to the combined V18 candidate, avoiding any implication of isolated
V17 performance evidence.

Evidence: `dist/retained-v18-v15-aligned/` links to `/tmp/phase18-abba1`, which
contains `comparison.json`, `block-summary.json`, per-trial raw observations,
producer traces, calibration records, frozen harnesses and an artifact manifest.
The prospective plan is `dist/viewer-heartbeat-mirror-v18-plan.json`; placement
evidence is `dist/viewer-heartbeat-v17-placement-retry.json`. V18 provenance is
`dist/retained-v18-source.json`, which records exactly four changed source/test
files from V15 and identical native assets. At measurement time focused/full
unit tests, types, formatting and production/test/browser builds passed;
integration and visual validation remained pending.
