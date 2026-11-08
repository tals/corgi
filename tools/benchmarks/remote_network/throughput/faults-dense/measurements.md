# Outage recovery measurements

Dense output. Seconds from link restoration to remotely echoed usable input; median [min–max].

| Outage | Corgi before | Corgi after | Herdr v0.9.5 |
| --- | ---: | ---: | ---: |
| 2 s | 1.041 [1.036–1.254], n=3 | 1.105 [1.043–1.131], n=3 | 1.698 [1.440–1.762], n=3 |
| 3 s | 2.662 [2.644–2.698], n=3 | 2.772 [2.737–2.876], n=3 | 3.846 [1.603–3.907], n=3 |
| 4 s | 1.648 [1.624–1.744], n=3 | 1.780 [1.754–1.803], n=3 | 2.868 [2.857–2.927], n=3 |
| 5 s | 0.632 [0.632–0.668], n=3 | 0.786 [0.753–0.855], n=3 | 1.956 [1.755–3.188], n=3 |
| 7 s | 3.518 [3.489–3.811], n=3 | 3.510 [3.505–3.531], n=3 | 5.555 [5.448–5.624], n=3 |
| 35 s | 2.599 [2.586–2.733], n=3 | 3.101 [2.591–3.539], n=3 | 13.397 [13.253–13.451], n=3 |

All scheduled results, including any failures, remain in [trial data](evidence/trials.csv) and [full evidence](evidence/summary.json).

Setup attaches are excluded from these aggregates. Three separate environments per product; the three products run simultaneously on disjoint CPU sets, rotated each round. Each trial uses real SSH, 120 ms RTT, four workloads on each of three machines, and whole-link packet loss for the stated duration. The observer requires matching screen header/footer markers, then a unique remote input echo. See the [playbook](README.md) for methodology and limitations.

Audit: 1008 checks passed; 0 problems. [Audit details](evidence/audit.json).
