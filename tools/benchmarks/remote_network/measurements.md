# Detailed measurements

[Short report](report.md) · [Reproduction playbook](README.md) · [Machine-readable summary](evidence/summary.json) · [Trial CSV](evidence/trials.csv)

Values are seconds unless stated otherwise. Brackets show the observed minimum–maximum across trials; central values are medians. Failed attempts are counted separately and do not become zero-second successes. These small samples do not estimate population reliability or confidence intervals.


## Connection init

| Product | RTT ms | SSH master | Usable / attempts | Fresh screen | Usable input |
| --- | --- | --- | --- | --- | --- |
| corgi | 0 | cold | 3/3 | 0.71 [0.71–0.71] | 0.75 [0.73–0.77] |
| corgi | 0 | warm | 3/3 | 0.47 [0.47–0.47] | 0.51 [0.50–0.51] |
| corgi | 20 | cold | 3/3 | 1.00 [0.99–1.04] | 1.09 [1.08–1.12] |
| corgi | 20 | warm | 3/3 | 0.60 [0.58–0.61] | 0.68 [0.67–0.68] |
| corgi | 120 | cold | 3/3 | 2.93 [2.92–3.01] | 3.11 [3.09–3.16] |
| corgi | 120 | warm | 3/3 | 1.50 [1.49–1.52] | 1.67 [1.67–1.70] |
| corgi | 300 | cold | 0/3 | — | — |
| corgi | 300 | warm | 3/3 | 3.13 [3.12–3.43] | 3.72 [3.72–3.77] |
| herdr | 0 | cold | 3/3 | 0.82 [0.81–0.84] | 0.87 [0.85–0.96] |
| herdr | 0 | warm | 3/3 | 0.55 [0.54–0.55] | 0.62 [0.59–0.63] |
| herdr | 20 | cold | 3/3 | 1.27 [1.25–1.28] | 1.35 [1.35–1.36] |
| herdr | 20 | warm | 3/3 | 0.82 [0.81–0.82] | 1.03 [1.01–1.03] |
| herdr | 120 | cold | 3/3 | 3.82 [3.82–3.82] | 4.33 [4.31–4.43] |
| herdr | 120 | warm | 3/3 | 2.37 [2.37–2.37] | 2.78 [2.76–2.90] |
| herdr | 300 | cold | 3/3 | 8.52 [8.52–8.53] | 9.44 [9.43–9.91] |
| herdr | 300 | warm | 3/3 | 5.08 [5.06–5.08] | 6.43 [6.02–6.43] |


## Recovery after network restoration

| Product | Fault | Measured fault window | Usable / trials | Fresh screen | Usable input |
| --- | --- | --- | --- | --- | --- |
| corgi | blackhole15 | 15.22 [15.13–15.29] | 3/3 | 2.37 [2.28–3.21] | 2.51 [2.42–3.39] |
| corgi | blackhole3 | 3.23 [3.21–3.30] | 3/3 | 4.01 [3.96–4.49] | 4.25 [4.16–4.67] |
| corgi | downstream15 | 15.24 [15.23–15.28] | 3/3 | 2.26 [2.22–3.19] | 2.41 [2.41–3.37] |
| corgi | isolated30 | 30.26 [30.24–30.26] | 3/3 | 3.77 [3.77–3.78] | 3.93 [3.92–3.94] |
| corgi | tcp_reset | — | 3/3 | 2.22 [2.20–2.23] | 2.39 [2.39–2.40] |
| herdr | blackhole15 | 15.28 [15.26–15.31] | 3/3 | 12.26 [10.59–12.66] | 13.03 [11.24–13.30] |
| herdr | blackhole3 | 3.27 [3.22–3.30] | 3/3 | 0.60 [0.50–0.94] | 0.79 [0.77–1.12] |
| herdr | downstream15 | 15.26 [15.22–15.30] | 3/3 | 13.23 [9.94–13.48] | 13.77 [10.58–14.14] |
| herdr | isolated30 | 30.27 [30.22–30.33] | 3/3 | 19.76 [19.76–19.78] | 20.30 [20.28–20.31] |
| herdr | tcp_reset | — | 3/3 | 4.14 [4.12–4.20] | 4.59 [4.54–4.65] |

`tcp_reset` starts after the kernel destroys the connection. Other recovery clocks start after packet forwarding is restored; outage duration is additional. The isolated-machine case includes navigating back to atlas.


## Healthy machines during atlas isolation

| Product | Destination | Fresh screen | Usable input | Follow-up echo |
| --- | --- | --- | --- | --- |
| corgi | borealis | 0.53 [0.53–0.53] | 0.71 [0.69–0.71] | 3/3 |
| corgi | local | 0.03 [0.03–0.05] | 0.07 [0.07–0.09] | 3/3 |
| herdr | borealis | 0.28 [0.28–0.30] | 0.77 [0.77–0.80] | 3/3 |
| herdr | local | 0.04 [0.04–0.05] | 0.11 [0.09–0.20] | 3/3 |


## Input submitted during outages

| Product | Fault | ~2 s input eventually received | ~8 s input eventually received | ~2 s delivery delay |
| --- | --- | --- | --- | --- |
| corgi | blackhole15 | 3/3 | 0/3 | 15.10 [15.09–16.11] |
| corgi | blackhole3 | 3/3 | 0/0 | 3.71 [3.70–3.72] |
| corgi | downstream15 | 3/3 | 0/3 | 15.10 [15.06–16.07] |
| corgi | isolated30 | 3/3 | 0/0 | 31.51 [31.48–31.53] |
| herdr | blackhole15 | 3/3 | 1/3 | 21.57 [21.48–21.72] |
| herdr | blackhole3 | 3/3 | 0/0 | 1.38 [1.30–1.46] |
| herdr | downstream15 | 3/3 | 0/3 | 0.06 [0.06–0.06] |
| herdr | isolated30 | 3/3 | 0/0 | 42.62 [42.57–42.74] |

Receipts establish execution at the remote producer, independently of visible echo. Zero receipt means the operation did not reach this producer during the retained run; it is not proof of a general exactly-once guarantee. `0/0` means no late probe was scheduled.


## Bandwidth and screen freshness

| Product / SSH compression | Workload | Cap / loss | Frames/s | Screen age p95 | Catch-up successes | Catch-up after lifting cap | Delivered kbit/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| corgi / default | dense | 1mbit | 5.73 [5.67–5.87] | 12.08 [12.02–12.35] | 3/3 | 4.59 [3.60–4.80] | 1000.03 [999.22–1000.84] |
| corgi / default | dense | 256kbit | 0.90 [0.77–1.03] | 29.95 [29.93–29.97] | 3/3 | 3.57 [1.53–9.56] | 256.13 [256.07–256.40] |
| corgi / default | dense | 64kbit | 0.20 [0.20–0.20] | 32.27 [32.24–32.28] | 3/3 | 10.73 [2.11–10.77] | 64.02 [63.97–64.09] |
| corgi / default | sparse | unlimited | 20.00 [20.00–20.00] | 0.09 [0.09–0.10] | 3/3 | 0.07 [0.07–0.10] | 1682.03 [1681.85–1684.62] |
| corgi / default | sparse | unlimited / 1% | 7.77 [5.87–9.60] | 6.86 [6.32–8.53] | 3/3 | 7.65 [7.07–8.73] | 1201.20 [1136.34–1266.08] |
| corgi / default | sparse | 1mbit | 5.70 [5.70–6.70] | 12.04 [12.03–12.06] | 3/3 | 3.84 [3.68–4.80] | 1000.07 [999.27–1000.07] |
| corgi / default | sparse | 256kbit | 0.93 [0.63–1.07] | 29.91 [29.89–29.92] | 3/3 | 1.42 [1.28–2.03] | 255.98 [255.61–255.99] |
| corgi / default | sparse | 64kbit | 0.20 [0.20–0.20] | 32.22 [32.22–32.23] | 3/3 | 2.13 [2.10–10.74] | 64.18 [64.10–64.31] |
| corgi / yes | dense | 256kbit | 1.63 | 27.98 | 1/1 | 1.28 | 256.23 |
| corgi / yes | sparse | 256kbit | 3.73 | 20.15 | 1/1 | 1.44 | 255.92 |
| corgi / yes | sparse | 64kbit | 0.80 | 31.08 | 1/1 | 15.28 | 63.83 |
| herdr / default | dense | 1mbit | 20.00 [20.00–20.00] | 0.10 [0.10–0.14] | 3/3 | 0.08 [0.07–0.09] | 843.27 [843.07–843.67] |
| herdr / default | dense | 256kbit | 6.17 [6.13–6.17] | 20.28 [20.08–20.90] | 3/3 | 0.98 [0.98–1.00] | 255.99 [255.91–256.18] |
| herdr / default | dense | 64kbit | 1.10 [1.07–1.17] | 30.85 [30.74–30.96] | 3/3 | 0.96 [0.91–1.06] | 64.17 [64.09–64.31] |
| herdr / default | sparse | unlimited | 20.00 [20.00–20.00] | 0.09 [0.07–0.11] | 3/3 | 0.11 [0.09–0.11] | 73.61 [73.53–73.75] |
| herdr / default | sparse | unlimited / 1% | 19.47 [19.40–19.50] | 0.10 [0.10–0.13] | 3/3 | 0.09 [0.08–0.09] | 73.85 [73.73–73.89] |
| herdr / default | sparse | 1mbit | 20.00 [20.00–20.00] | 0.09 [0.09–0.10] | 3/3 | 0.09 [0.08–0.11] | 73.84 [73.55–73.84] |
| herdr / default | sparse | 256kbit | 20.00 [20.00–20.00] | 0.10 [0.09–0.10] | 3/3 | 0.10 [0.08–0.11] | 73.65 [73.60–73.71] |
| herdr / default | sparse | 64kbit | 14.00 [13.73–14.27] | 7.25 [7.21–8.19] | 3/3 | 0.16 [0.14–0.17] | 63.97 [63.89–63.99] |

The p95 is computed over wall time within each 30-second trial, including frozen screens, then summarized across trials. Loss rows also add 10 ms normal jitter per direction. The workload continues unchanged after lifting the cap. Compression=yes is an exploratory configuration diagnostic with one trial, separate from defaults.


## Input under bandwidth pressure

| Product / SSH compression | Workload | Cap / loss | Visible within window | Eventually received | Visible echo latency |
| --- | --- | --- | --- | --- | --- |
| corgi / default | dense | 1mbit | 9/15 | 15/15 | 6.26 [3.41–9.97] |
| corgi / default | dense | 256kbit | 0/15 | 9/15 | — |
| corgi / default | dense | 64kbit | 0/15 | 6/15 | — |
| corgi / default | sparse | unlimited | 15/15 | 15/15 | 0.16 [0.13–0.18] |
| corgi / default | sparse | unlimited / 1% | 12/15 | 15/15 | 2.72 [0.17–8.30] |
| corgi / default | sparse | 1mbit | 9/15 | 15/15 | 6.59 [3.38–10.16] |
| corgi / default | sparse | 256kbit | 0/15 | 6/15 | — |
| corgi / default | sparse | 64kbit | 0/15 | 6/15 | — |
| corgi / yes | dense | 256kbit | 0/5 | 1/5 | — |
| corgi / yes | sparse | 256kbit | 2/5 | 3/5 | 12.80 [8.89–16.70] |
| corgi / yes | sparse | 64kbit | 0/5 | 3/5 | — |
| herdr / default | dense | 1mbit | 15/15 | 15/15 | 0.19 [0.15–0.20] |
| herdr / default | dense | 256kbit | 6/15 | 15/15 | 17.68 [12.69–20.39] |
| herdr / default | dense | 64kbit | 0/15 | 15/15 | — |
| herdr / default | sparse | unlimited | 15/15 | 15/15 | 0.16 [0.13–0.17] |
| herdr / default | sparse | unlimited / 1% | 15/15 | 15/15 | 0.16 [0.12–0.28] |
| herdr / default | sparse | 1mbit | 15/15 | 15/15 | 0.17 [0.12–0.17] |
| herdr / default | sparse | 256kbit | 15/15 | 15/15 | 0.16 [0.14–0.17] |
| herdr / default | sparse | 64kbit | 12/15 | 15/15 | 1.98 [0.77–3.39] |

Latency describes visible successes only; the adjacent counts keep missing acknowledgements visible. The first input is sent after the counter snapshot, then approximately every six seconds.


## Real elapsed-time client freezes

| Product | Freeze seconds | Fresh screen after wake | Usable input after wake | Pending operation receipts | Remote workloads continued | Follow-up echo |
| --- | --- | --- | --- | --- | --- | --- |
| corgi | 180 | 2.58 | 2.73 | 1 | True | True |
| herdr | 180 | 4.77 | 5.26 | 1 | True | True |
| herdr | 660 | 14.68 | 15.10 | 1 | True | True |
| corgi | 660 | 3.05 | 3.23 | 1 | True | True |

Duplicate input tokens across these retained trials: **0**. Each sleep duration has one observation per product.


## Raw evidence index

| Trial | Results | Terminal and network records |
| --- | --- | --- |
| startup-1-corgi | [JSON](../../../dist/remote-network-20261106/raw/startup-1-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/startup-1-corgi/) |
| startup-1-herdr | [JSON](../../../dist/remote-network-20261106/raw/startup-1-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/startup-1-herdr/) |
| faults-1-herdr | [JSON](../../../dist/remote-network-20261106/raw/faults-1-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/faults-1-herdr/) |
| faults-1-corgi | [JSON](../../../dist/remote-network-20261106/raw/faults-1-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/faults-1-corgi/) |
| stream-1-corgi | [JSON](../../../dist/remote-network-20261106/raw/stream-1-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/stream-1-corgi/) |
| stream-1-herdr | [JSON](../../../dist/remote-network-20261106/raw/stream-1-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/stream-1-herdr/) |
| startup-2-herdr | [JSON](../../../dist/remote-network-20261106/raw/startup-2-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/startup-2-herdr/) |
| startup-2-corgi | [JSON](../../../dist/remote-network-20261106/raw/startup-2-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/startup-2-corgi/) |
| faults-2-corgi | [JSON](../../../dist/remote-network-20261106/raw/faults-2-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/faults-2-corgi/) |
| faults-2-herdr | [JSON](../../../dist/remote-network-20261106/raw/faults-2-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/faults-2-herdr/) |
| stream-2-herdr | [JSON](../../../dist/remote-network-20261106/raw/stream-2-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/stream-2-herdr/) |
| stream-2-corgi | [JSON](../../../dist/remote-network-20261106/raw/stream-2-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/stream-2-corgi/) |
| startup-3-corgi | [JSON](../../../dist/remote-network-20261106/raw/startup-3-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/startup-3-corgi/) |
| startup-3-herdr | [JSON](../../../dist/remote-network-20261106/raw/startup-3-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/startup-3-herdr/) |
| faults-3-herdr | [JSON](../../../dist/remote-network-20261106/raw/faults-3-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/faults-3-herdr/) |
| faults-3-corgi | [JSON](../../../dist/remote-network-20261106/raw/faults-3-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/faults-3-corgi/) |
| stream-3-corgi | [JSON](../../../dist/remote-network-20261106/raw/stream-3-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/stream-3-corgi/) |
| stream-3-herdr | [JSON](../../../dist/remote-network-20261106/raw/stream-3-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/stream-3-herdr/) |
| sleep-180-corgi | [JSON](../../../dist/remote-network-20261106/raw/sleep-180-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/sleep-180-corgi/) |
| sleep-180-herdr | [JSON](../../../dist/remote-network-20261106/raw/sleep-180-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/sleep-180-herdr/) |
| sleep-660-herdr | [JSON](../../../dist/remote-network-20261106/raw/sleep-660-herdr/results.json) | [Directory](../../../dist/remote-network-20261106/raw/sleep-660-herdr/) |
| sleep-660-corgi | [JSON](../../../dist/remote-network-20261106/raw/sleep-660-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/sleep-660-corgi/) |
| compression-corgi | [JSON](../../../dist/remote-network-20261106/raw/compression-corgi/results.json) | [Directory](../../../dist/remote-network-20261106/raw/compression-corgi/) |
