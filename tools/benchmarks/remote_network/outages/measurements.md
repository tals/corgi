# Outage recovery measurements

Seconds from link restoration to remotely echoed usable input; median [min–max].

| Outage | Rebased Corgi before | Corgi after | Herdr v0.9.5 |
| --- | ---: | ---: | ---: |
| 3 s | 2.405 [2.262–2.507], n=3 | 2.387 [2.266–2.557], n=3 | 0.885 [0.848–0.951], n=3 |
| 15 s | 3.275 [3.187–3.370], n=3 | 3.172 [2.485–3.283], n=3 | 11.452 [10.826–13.593], n=3 |
| 35 s | 10.139 [2.650–10.144], n=3 | 3.507 [3.398–3.553], n=3 | 14.395 [14.257–18.893], n=3 |
| 60 s | 2.948 [2.769–17.555], n=3 | 2.653 [2.543–3.454], n=3 | 19.877 [19.740–19.926], n=3 |

All scheduled results, including any failures, remain in [trial data](evidence/trials.csv) and [full evidence](evidence/summary.json).

Setup attaches are excluded from these aggregates. Three separate environments per product; the three products run simultaneously on disjoint CPU sets, rotated each round. Each trial uses real SSH, 120 ms RTT, four workloads on each of three machines, and whole-link packet loss for the stated duration. The observer requires matching screen header/footer markers, then a unique remote input echo. See the [playbook](README.md) for methodology and limitations.

Audit: 675 checks passed; 0 problems. [Audit details](evidence/audit.json).
