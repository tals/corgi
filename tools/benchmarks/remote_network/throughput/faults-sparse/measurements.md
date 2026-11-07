# Outage recovery measurements

Sparse output. Seconds from link restoration to remotely echoed usable input; median [min–max].

| Outage | Corgi before | Corgi after | Herdr v0.9.5 |
| --- | ---: | ---: | ---: |
| 2 s | 1.049 [1.048–1.117], n=3 | 1.098 [1.051–1.204], n=3 | 1.766 [0.783–1.904], n=3 |
| 3 s | 2.789 [2.752–2.852], n=3 | 2.687 [2.658–2.764], n=3 | 1.285 [1.011–1.356], n=3 |
| 4 s | 1.652 [1.643–1.655], n=3 | 1.641 [1.633–1.709], n=3 | 2.644 [2.599–2.654], n=3 |
| 5 s | 0.670 [0.648–0.796], n=3 | 0.796 [0.746–0.847], n=3 | 2.522 [2.446–2.752], n=3 |
| 7 s | 3.564 [3.558–3.591], n=3 | 3.511 [3.502–3.519], n=3 | 6.683 [5.001–6.804], n=3 |
| 35 s | 2.701 [2.664–3.146], n=3 | 2.657 [2.631–3.562], n=3 | 18.861 [14.547–19.214], n=3 |

All scheduled results, including any failures, remain in [trial data](evidence/trials.csv) and [full evidence](evidence/summary.json).

Setup attaches are excluded from these aggregates. Three separate environments per product; the three products run simultaneously on disjoint CPU sets, rotated each round. Each trial uses real SSH, 120 ms RTT, four workloads on each of three machines, and whole-link packet loss for the stated duration. The observer requires matching screen header/footer markers, then a unique remote input echo. See the [playbook](README.md) for methodology and limitations.

Audit: 1008 checks passed; 0 problems. [Audit details](evidence/audit.json).
