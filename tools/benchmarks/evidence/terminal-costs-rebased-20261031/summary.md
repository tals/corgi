# Unmodified main versus rebased candidate

Each row is one matched pair of 30-second observations after 15-second warmups, not a confidence interval or causal effect estimate.
CPU is percent of one logical CPU, including all daemon/viewer threads. Providers and harness are excluded; detached viewers exited (—).

| Agents | State | Viewer | Main daemon | Candidate daemon | Main viewer | Candidate viewer | Main total | Candidate total | Total change (pp) | Total reduction | Main child* | Candidate child* |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | idle | attached | 4.766% | 2.000% | 3.733% | 1.367% | 8.499% | 3.367% | -5.132 | 60.387% | 0.033% | 0.033% |
| 8 | idle | detached | 2.700% | 1.367% | — | — | 2.700% | 1.367% | -1.333 | 49.381% | 0.000% | 0.000% |
| 8 | streaming | attached | 10.833% | 5.233% | 7.900% | 3.567% | 18.733% | 8.800% | -9.933 | 53.025% | 0.033% | 0.000% |
| 8 | streaming | detached | 6.198% | 3.932% | — | — | 6.198% | 3.932% | -2.266 | 36.555% | 0.000% | 0.000% |
| 64 | idle | attached | 13.498% | 5.700% | 6.766% | 2.166% | 20.264% | 7.866% | -12.398 | 61.182% | 0.033% | 0.000% |
| 64 | idle | detached | 11.464% | 5.064% | — | — | 11.464% | 5.064% | -6.400 | 55.826% | 0.000% | 0.033% |
| 64 | streaming | attached | 47.133% | 17.267% | 15.933% | 5.433% | 63.066% | 22.700% | -40.366 | 64.006% | 1.433% | 1.367% |
| 64 | streaming | detached | 38.100% | 14.527% | — | — | 38.100% | 14.527% | -23.574 | 61.872% | 0.033% | 0.033% |

*Waited-child CPU is separate from totals. Linux charges it on wait, potentially including work before the sample; it is not a contemporaneous subtree total.

Sparse 20 Hz staggered producers, one visible first-agent pane, 160×48 host / 132×47 PTYs, default animation/resources, minimal transcripts and isolated non-Git projects.
Real inference, full Codex app-server polling and repository/worktree/push scanning are excluded.
Both legs share NUMA/core/memory placement and strict 2% whole-trial/measured-window sibling guards. Preflight and rejected timings are excluded.
Leader affinity and recursive utilization clamps are checked; child-thread affinity is inherited but not exhaustively recorded.
Observed frequency is diagnostic, not effective execution cycles; time/frequency flags never change acceptance or normalize CPU.

- 8-idle: candidate → main, NUMA 1, CPUs `120,121,122,123,124,125,126,127`, gap 0.386s; [main receipt](8-idle/main/comparison.json), [candidate receipt](8-idle/candidate/comparison.json).
- 8-busy: main → candidate, NUMA 1, CPUs `120,121,122,123,124,125,126,127`, gap 0.381s; [main receipt](8-busy/main/comparison.json), [candidate receipt](8-busy/candidate/comparison.json).
- 64-idle: candidate → main, NUMA 1, CPUs `120,121,122,123,124,125,126,127`, gap 0.375s; [main receipt](64-idle/main/comparison.json), [candidate receipt](64-idle/candidate/comparison.json).
- 64-busy: main → candidate, NUMA 1, CPUs `120,121,122,123,124,125,126,127`, gap 0.376s; [main receipt](64-busy/main/comparison.json), [candidate receipt](64-busy/candidate/comparison.json).
- Diagnostic, 8-idle detached: observed frequency differs by more than 5%; diagnostic only.
- Diagnostic, 8-busy attached: observed frequency differs by more than 5%; diagnostic only.
- Diagnostic, 64-idle attached: observed frequency differs by more than 5%; diagnostic only.
- Diagnostic, 64-idle detached: observed frequency differs by more than 5%; diagnostic only.

Complete pairs: 4. Missing pairs: 0. Excluded incomplete source pairs: 0.
[Exact component differences, timestamps, frequency diagnostics, source hashes and plans](summary.json)
