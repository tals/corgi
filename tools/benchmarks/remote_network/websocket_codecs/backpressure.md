# Backpressure: retain the transient

Dense 20 Hz output, 600 ms RTT, 64 kbit/s per direction. Each value is the median of three trial P95s, with the observed trial range. The last ten seconds are supplementary; the headline results retain the full 30-second sample after the standard four-second settling period.

| Cohort | Mode | Whole-window P95 age, s | Final-ten-second P95 age, s |
| --- | --- | ---: | ---: |
| main | WS uncompressed | 4.37 [3.19–4.68] | 2.94 [2.93–2.97] |
| main | WS zstd | 3.05 [2.16–3.40] | 0.95 [0.95–0.96] |
| main | WS native deflate | 3.45 [0.98–3.46] | 1.00 [0.98–1.01] |
| main | Herdr + SSH-C | 30.31 [30.24–30.80] | 31.25 [31.21–31.81] |
| four-core | WS uncompressed | 10.00 [4.64–18.74] | 2.94 [2.90–19.74] |
| four-core | WS zstd | 1.08 [0.98–2.38] | 0.98 [0.98–0.98] |
| four-core | WS native deflate | 2.31 [1.94–2.34] | 0.99 [0.99–1.01] |
| four-core | Herdr + SSH-C | 30.79 [30.60–30.99] | 31.80 [31.60–31.89] |
| raw-accounting | WS zstd | 2.93 [1.60–3.12] | 0.98 [0.97–1.05] |

The main cohort uses two physical cores per lab, with all scenario suites running concurrently on disjoint cores. The separate control uses four cores per lab and runs only this suite, so **both CPU allocation and host concurrency change**. It cannot isolate which scheduling detail changes the initial burst. It does show that the transient varies while the compressed modes settle to similar ages. Do not replace the main median with the more favorable control median.

The controller trace records a path probe measuring 602 ms, a temporary 40-frame allowance, and later shrinking windows as receipt delay rises. The byte budget still limits actual outstanding data: the allowance is not the number of pending frames. This is consistent with adaptation and queue drain, not evidence of a steady decompression bottleneck. The traced run is a separate diagnostic on the quieter allocation; it does not establish the exact cause of every larger transient in the main cohort.

[All per-trial age reductions and controller events](evidence/backpressure.json) · [12/12 control labs, 380 checks passed](evidence/four-core/audit.json) · [Control distributions](evidence/four-core/summary.json).

For the high-cadence accounting check, normal zstd delivered 59.9 [59.87–59.93] updates/s; changing only its accounting callback to raw bytes gave 59.1 [59.03–59.30]. Native deflate gave 59.1 [59.07–59.13]. At the severe low-bandwidth condition above, the ranges overlap and the control does not establish a stable codec ranking. [Full measurements](measurements.md#streaming).

Reproduce the control after the main matrix has finished:

```sh
python3 tools/benchmarks/remote_network/websocket_codecs/matrix.py \
  dist/websocket-codecs-builds/corgi-identity \
  dist/websocket-codecs-builds/corgi-zstd \
  dist/websocket-codecs-builds/corgi-deflate \
  /absolute/path/to/herdr-v0.9.5 dist/websocket-codecs-four-core \
  --zstd-raw dist/websocket-codecs-builds/corgi-zstd-raw \
  --suites stream-600-low --cpus-per-lab 4

python3 tools/benchmarks/remote_network/websocket_codecs/audit.py \
  dist/websocket-codecs-four-core dist/websocket-codecs-four-core-reduction

python3 tools/benchmarks/remote_network/adaptive_run.py corgi \
  dist/websocket-codecs-builds/corgi-zstd dist/websocket-codecs-low-trace/zstd \
  --suite stream --stream-rtt 600 --stream-cases dense:64kbit --trace --cpus 0-3

python3 tools/benchmarks/remote_network/websocket_codecs/backpressure.py \
  dist/websocket-codecs-network dist/websocket-codecs-four-core \
  dist/websocket-codecs-low-trace/zstd \
  tools/benchmarks/remote_network/websocket_codecs/evidence/backpressure.json
```
