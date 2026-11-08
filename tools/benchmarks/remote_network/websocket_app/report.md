# WebSocket versus the reviewed Corgi transport

**WS+zstd kept frame rate, bandwidth and recovery close to the current transport,
with about one extra RTT at startup/reconnection.** Bun supplies standard
WebSocket framing. Zstd runs inside binary messages; the native compression
extension is deflate.
[Verified capabilities and specifications](capabilities.md).

120 isolated application labs; three repetitions per arm/scenario. Medians:

| Scenario / metric | Corgi direct | Corgi over WS | Stock Herdr + SSH-C |
| --- | ---: | ---: | ---: |
| First uncached UI, 120 ms RTT | 2.40 s | 2.54 s | 3.94 s |
| First pane content, same launch | 2.84 s | 2.98 s | 3.94 s |
| Sparse 20 Hz / 1 Mbit/s: total traffic | 80 kbit/s | 81 kbit/s | 79 kbit/s |
| Dense 20 Hz / 1 Mbit/s: total traffic | 358 kbit/s | 359 kbit/s | 873 kbit/s |
| Dense 60 Hz, 300 ms / 1 Mbit/s: updates/s | 60.0 | 59.9 | 23.6 |
| Dense, 600 ms / 64 kbit/s: P95 display age | 0.99 s | 1.00 s | 30.22 s |
| 64 kbit/s → 1 Mbit/s: first fresh content | 0.17 s | 0.08 s | None within 10 s |
| 3-second outage: usable after restore | 3.16 s | 3.13 s | 0.92 s |
| 35-second outage: usable after restore | 2.69 s | 2.74 s | 17.71 s |
| 3-minute client freeze, no pending input: usable | 2.35 s | 2.48 s | 4.67 s |
| Same freeze, input sent immediately beforehand | 2.48 s | 2.62 s | 13.42 s |

The control adds the same socket hops: UI/content took 2.43/2.86 s, isolating
roughly 120 ms of WS upgrade cost. At 600 ms RTT, first content was 11.47 s direct
versus 12.10 s over WS. CPU ranges overlap; small timing differences do not
establish a WS speedup.
[All four arms, ranges, CPU and evidence](measurements.md).

Herdr measured **13.42 s here**; earlier runs ranged **13–47 s**. The
[freeze audit](sleep-interpretation.md) explains the timer-sensitive recovery
path. This batch did not capture TCP timers. Freeze means stopped processes,
packet loss and server TCP teardown, not physical suspend.

**Recommendation:** use WS+zstd if we adopt WebSocket. Native deflate uses less
CPU but more traffic in the [316 component trials](../websocket_eval/report.md).
Production integration still needs daemon handoff and a measured welcome/upgrade
design that avoids the extra hello RTT. The test-drive branch retains the
[reviewed stream implementation](../adaptive-production/review/report.md).

[Reproduce](README.md) · [4,209 audit checks, zero problems](evidence/audit.json)
· [Exact builds and patches](evidence/builds.json)
· [Raw evidence archive](../../../../dist/corgi-websocket-evidence-20261108.tar.gz)
([SHA-256](evidence/artifacts.json)).
