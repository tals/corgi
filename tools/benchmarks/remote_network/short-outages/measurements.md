# Short-outage recovery measurements

Seconds from link restoration to remotely echoed usable input; median [min–max].

Normal Corgi is `35cef14d`. The diagnostic is an ablation, **not a fix**.
The raw labels `before`/`after` mean normal/ablation. Herdr v0.9.5 is unchanged.

| Outage | Normal Corgi | Diagnostic: no receipts or frame limits | Herdr v0.9.5 |
| --- | ---: | ---: | ---: |
| 2 s | 1.070 [1.065–1.108], n=3 | 1.113 [1.105–1.128], n=3 | 0.704 [0.610–0.715], n=3 |
| 3 s | 2.662 [2.656–2.830], n=3 | 1.321 [1.195–1.361], n=3 | 0.969 [0.924–1.058], n=3 |
| 4 s | 1.673 [1.650–1.767], n=3 | 2.764 [1.675–2.817], n=3 | 2.625 [1.167–3.270], n=3 |
| 5 s | 0.753 [0.719–0.765], n=3 | 2.675 [2.575–2.716], n=3 | 2.566 [2.509–2.724], n=3 |
| 7 s | 3.515 [3.513–3.516], n=3 | 1.667 [1.576–1.717], n=3 | 1.061 [0.995–5.256], n=3 |

All scheduled results, including any failures, remain in [trial data](evidence/trials.csv) and [full evidence](evidence/summary.json).

Setup attaches are excluded from these aggregates. Three separate environments per product; the three products run simultaneously on disjoint CPU sets, rotated each round. Each trial uses real SSH, 120 ms RTT, four workloads on each of three machines, and whole-link packet loss for the stated duration. The observer requires matching screen header/footer markers, then a unique remote input echo. See the [playbook](README.md) for methodology and limitations.

Audit: 819 checks passed; 0 problems. [Audit details](evidence/audit.json).

Observed fault windows include the time to apply and remove the isolated qdiscs.
Snapshot collection runs independently of the restoration deadline.

| Configured loss | Observed window, all nine trials |
| --- | ---: |
| 2 s | 2.061–2.077 s |
| 3 s | 3.064–3.085 s |
| 4 s | 4.064–4.077 s |
| 5 s | 5.061–5.077 s |
| 7 s | 7.067–7.085 s |

All 45 measured recoveries have successful pre-/post-fault input and independent
receipts for the echoed recovery token. There are no duplicate input tokens;
all twelve producers survive every case. The earlier matrices with delayed
restoration and the diagnostic pre-fault input failure remain in
[excluded experiment evidence](evidence/experiments.json). They are not pooled
with these results.
