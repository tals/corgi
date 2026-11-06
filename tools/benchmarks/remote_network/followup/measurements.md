# Detailed measurements

[Short report](report.md) · [Reproduction playbook](README.md) · [Machine-readable summary](evidence/summary.json) · [Trial CSV](evidence/trials.csv)

Values are seconds unless stated otherwise. Brackets show the observed minimum–maximum across trials; central values are medians. Failed attempts are counted separately and do not become zero-second successes. These small samples do not estimate population reliability or confidence intervals.

Corgi rows use three trials of the measured 691fc36b build, except the single-trial freezes. Herdr rows are the additional one-round control with the corrected producer. The short report compares against the [original three-trial Herdr reference](../measurements.md). Both products used identical measurement code for the runs below.


## Connection init

| Product | RTT ms | SSH master | Usable / attempts | Fresh screen | Usable input |
| --- | --- | --- | --- | --- | --- |
| corgi | 0 | cold | 3/3 | 0.71 [0.71–0.72] | 0.76 [0.73–0.77] |
| corgi | 0 | warm | 3/3 | 0.45 [0.45–0.45] | 0.48 [0.47–0.48] |
| corgi | 20 | cold | 3/3 | 1.00 [1.00–1.00] | 1.07 [1.07–1.08] |
| corgi | 20 | warm | 3/3 | 0.61 [0.60–0.61] | 0.70 [0.67–0.70] |
| corgi | 120 | cold | 3/3 | 2.93 [2.92–2.93] | 3.09 [3.08–3.11] |
| corgi | 120 | warm | 3/3 | 1.50 [1.50–1.51] | 1.67 [1.64–1.67] |
| corgi | 300 | cold | 3/3 | 6.35 [6.34–6.38] | 6.71 [6.71–6.73] |
| corgi | 300 | warm | 3/3 | 3.12 [3.12–3.13] | 3.46 [3.45–3.73] |


## Recovery after network restoration

| Product | Fault | Measured fault window | Usable / trials | Fresh screen | Usable input |
| --- | --- | --- | --- | --- | --- |
| corgi | blackhole15 | 15.24 [15.22–15.25] | 3/3 | 3.20 [3.17–3.24] | 3.41 [3.31–3.45] |
| corgi | blackhole3 | 3.28 [3.25–3.30] | 3/3 | 2.33 [2.29–2.33] | 2.49 [2.45–2.51] |
| corgi | downstream15 | 15.22 [15.22–15.27] | 3/3 | 3.21 [3.10–3.22] | 3.37 [3.24–3.37] |
| corgi | isolated30 | 30.27 [30.24–30.29] | 3/3 | 3.86 [3.58–3.98] | 4.00 [3.73–4.16] |
| corgi | tcp_reset | — | 3/3 | 2.23 [2.22–2.23] | 2.39 [2.38–2.40] |

`tcp_reset` starts after the kernel destroys the connection. Other recovery clocks start after packet forwarding is restored; outage duration is additional. The isolated-machine case includes navigating back to atlas.


## Healthy machines during atlas isolation

| Product | Destination | Fresh screen | Usable input | Follow-up echo |
| --- | --- | --- | --- | --- |
| corgi | borealis | 0.41 [0.40–0.41] | 0.56 [0.55–0.56] | 3/3 |
| corgi | local | 0.05 [0.05–0.05] | 0.09 [0.08–0.10] | 3/3 |


## Input submitted during outages

| Product | Fault | ~2 s input eventually received | ~8 s input eventually received | ~2 s delivery delay |
| --- | --- | --- | --- | --- |
| corgi | blackhole15 | 3/3 | 0/3 | 16.05 [16.02–16.05] |
| corgi | blackhole3 | 3/3 | 0/0 | 3.45 [3.44–3.47] |
| corgi | downstream15 | 3/3 | 0/3 | 16.04 [15.99–16.05] |
| corgi | isolated30 | 3/3 | 0/0 | 31.62 [31.32–31.68] |

Receipts establish execution at the remote producer, independently of visible echo. Zero receipt means the operation did not reach this producer during the retained run; it is not proof of a general exactly-once guarantee. `0/0` means no late probe was scheduled.


## Bandwidth and screen freshness

| Product / SSH compression | Workload | Cap / loss | Frames/s | Screen age p95 | Catch-up successes | Catch-up after lifting cap | Delivered kbit/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| corgi / default | dense | 1mbit | 14.00 [13.97–14.00] | 0.21 [0.17–0.22] | 3/3 | 0.11 [0.08–0.14] | 446.00 [445.09–446.26] |
| corgi / default | dense | 256kbit | 8.00 [7.97–8.00] | 0.36 [0.35–0.36] | 3/3 | 0.12 [0.10–0.13] | 255.94 [255.74–256.03] |
| corgi / default | dense | 64kbit | 1.93 [1.90–1.97] | 1.49 [1.48–1.51] | 3/3 | 0.17 [0.16–0.21] | 63.99 [63.83–64.03] |
| corgi / default | sparse | unlimited | 20.00 [20.00–20.00] | 0.10 [0.09–0.10] | 3/3 | 0.08 [0.07–0.11] | 201.88 [201.16–201.97] |
| corgi / default | sparse | unlimited / 1% | 17.47 [17.37–18.10] | 0.21 [0.19–0.22] | 3/3 | 0.08 [0.07–0.11] | 185.25 [183.78–188.50] |
| corgi / default | sparse | 1mbit | 20.00 [19.87–20.00] | 0.11 [0.10–0.12] | 3/3 | 0.08 [0.06–0.09] | 201.51 [201.28–201.75] |
| corgi / default | sparse | 256kbit | 20.00 [19.97–20.00] | 0.12 [0.12–0.13] | 3/3 | 0.08 [0.08–0.09] | 201.51 [201.09–202.06] |
| corgi / default | sparse | 64kbit | 6.80 [6.77–6.80] | 0.57 [0.57–0.59] | 3/3 | 0.15 [0.14–0.17] | 63.90 [63.88–64.13] |
| herdr / default | dense | 1mbit | 20.00 | 0.10 | 1/1 | 0.07 | 844.10 |
| herdr / default | dense | 256kbit | 5.37 | 21.23 | 1/1 | 0.74 | 255.88 |
| herdr / default | dense | 64kbit | 1.00 | 31.05 | 1/1 | 1.02 | 64.16 |
| herdr / default | sparse | unlimited | 20.00 | 0.09 | 1/1 | 0.11 | 73.68 |
| herdr / default | sparse | unlimited / 1% | 19.40 | 0.13 | 1/1 | 0.10 | 73.75 |
| herdr / default | sparse | 1mbit | 20.00 | 0.11 | 1/1 | 0.06 | 73.66 |
| herdr / default | sparse | 256kbit | 20.00 | 0.10 | 1/1 | 0.08 | 73.51 |
| herdr / default | sparse | 64kbit | 14.23 | 7.15 | 1/1 | 0.13 | 64.09 |

The p95 is computed over wall time within each 30-second trial, including frozen screens, then summarized across trials. Loss rows also add 10 ms normal jitter per direction. The workload continues unchanged after lifting the cap. Compression=yes is an exploratory configuration diagnostic with one trial, separate from defaults.


## Input under bandwidth pressure

| Product / SSH compression | Workload | Cap / loss | Visible within window | Eventually received | Visible echo latency |
| --- | --- | --- | --- | --- | --- |
| corgi / default | dense | 1mbit | 15/15 | 15/15 | 0.19 [0.17–0.23] |
| corgi / default | dense | 256kbit | 15/15 | 15/15 | 0.37 [0.28–0.38] |
| corgi / default | dense | 64kbit | 15/15 | 15/15 | 1.39 [1.19–1.59] |
| corgi / default | sparse | unlimited | 15/15 | 15/15 | 0.17 [0.14–0.19] |
| corgi / default | sparse | unlimited / 1% | 15/15 | 15/15 | 0.18 [0.11–0.31] |
| corgi / default | sparse | 1mbit | 15/15 | 15/15 | 0.16 [0.14–0.17] |
| corgi / default | sparse | 256kbit | 15/15 | 15/15 | 0.14 [0.13–0.15] |
| corgi / default | sparse | 64kbit | 15/15 | 15/15 | 0.55 [0.48–0.70] |
| herdr / default | dense | 1mbit | 5/5 | 5/5 | 0.20 [0.19–0.20] |
| herdr / default | dense | 256kbit | 2/5 | 5/5 | 17.06 [15.52–18.60] |
| herdr / default | dense | 64kbit | 0/5 | 5/5 | — |
| herdr / default | sparse | unlimited | 5/5 | 5/5 | 0.17 [0.16–0.17] |
| herdr / default | sparse | unlimited / 1% | 5/5 | 5/5 | 0.16 [0.13–0.17] |
| herdr / default | sparse | 1mbit | 5/5 | 5/5 | 0.15 [0.15–0.15] |
| herdr / default | sparse | 256kbit | 5/5 | 5/5 | 0.16 [0.13–0.16] |
| herdr / default | sparse | 64kbit | 4/5 | 5/5 | 1.98 [0.79–3.35] |

Latency describes visible successes only; the adjacent counts keep missing acknowledgements visible. The first input is sent after the counter snapshot, then approximately every six seconds.


## Real elapsed-time client freezes

| Product | Freeze seconds | Fresh screen after wake | Usable input after wake | Pending operation receipts | Remote workloads continued | Follow-up echo |
| --- | --- | --- | --- | --- | --- | --- |
| corgi | 180 | 2.44 | 2.60 | 1 | True | True |
| corgi | 660 | 2.81 | 2.96 | 1 | True | True |

Duplicate input tokens across these retained trials: **0**. Each sleep duration has one observation per product.


## Raw evidence index

| Trial | Results | Terminal and network records |
| --- | --- | --- |
| sleep-180-corgi | [JSON](../../../../dist/remote-network-followup-final/sleep-180-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/sleep-180-corgi/) |
| sleep-660-corgi | [JSON](../../../../dist/remote-network-followup-final/sleep-660-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/sleep-660-corgi/) |
| stream-1-corgi | [JSON](../../../../dist/remote-network-followup-final/stream-1-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/stream-1-corgi/) |
| startup-1-corgi | [JSON](../../../../dist/remote-network-followup-final/startup-1-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/startup-1-corgi/) |
| faults-1-corgi | [JSON](../../../../dist/remote-network-followup-final/faults-1-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/faults-1-corgi/) |
| stream-2-corgi | [JSON](../../../../dist/remote-network-followup-final/stream-2-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/stream-2-corgi/) |
| startup-2-corgi | [JSON](../../../../dist/remote-network-followup-final/startup-2-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/startup-2-corgi/) |
| faults-2-corgi | [JSON](../../../../dist/remote-network-followup-final/faults-2-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/faults-2-corgi/) |
| stream-3-corgi | [JSON](../../../../dist/remote-network-followup-final/stream-3-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/stream-3-corgi/) |
| startup-3-corgi | [JSON](../../../../dist/remote-network-followup-final/startup-3-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/startup-3-corgi/) |
| faults-3-corgi | [JSON](../../../../dist/remote-network-followup-final/faults-3-corgi/results.json) | [Directory](../../../../dist/remote-network-followup-final/faults-3-corgi/) |
| stream-control-herdr | [JSON](../../../../dist/remote-network-followup-final/stream-control-herdr/results.json) | [Directory](../../../../dist/remote-network-followup-final/stream-control-herdr/) |
