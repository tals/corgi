# Corgi versus Herdr with live-history zstd

**Compression makes Corgi much more bandwidth-efficient and preserves its backpressure advantage. High RTT and short outages remain weaknesses.**

These are actual end-to-end measurements: unchanged binaries, real SSH and an external Bun zstd level-3 adapter, with live history and **no trained dictionary**. Medians of three independent trials. The primary Herdr baseline is **stock Herdr with the installed SSH client’s normal `-C` compression enabled**; the additional Herdr + zstd column gives both products the same codec. [Negotiation proof](evidence/ssh-negotiation.txt).

Unless stated otherwise, RTT is 120 ms. Traffic includes both directions and SSH/TCP overhead. Lower traffic, lag and recovery time are better; higher updates/s is better.

| Scenario / metric | Corgi + zstd | Stock Herdr + SSH -C | Herdr + same zstd |
| --- | ---: | ---: | ---: |
| Good connection, 20 ms, uncapped dense: updates/s | 20.0 | 20.0 | 20.0 |
| Sparse, 1 Mbit/s: total kbit/s | 77.8 | 79.4 | 38.4 |
| Dense, 1 Mbit/s: total kbit/s | 354.4 | 872.7 | 441.7 |
| Sparse, 64 kbit/s: updates/s / p95 lag | 19.9 / 0.11 s | 14.0 / 7.25 s | 20.0 / 0.09 s |
| Dense, 64 kbit/s: updates/s / p95 lag | 4.1 / 0.68 s | 1.1 / 30.85 s | 2.3 / 28.67 s |
| Dense, 300 ms RTT, 1 Mbit/s: updates/s | 6.5 | 20.0 | 20.0 |
| Cold connection: usable in | 3.18 s | 4.33 s | 4.20 s |
| 3 s sparse outage: usable after restoration | 2.69 s | 1.26 s | 0.55 s |
| 3 s dense outage: usable after restoration | 2.77 s | 3.91 s | 1.66 s |
| 35 s dense outage: usable after restoration | 2.55 s | 13.40 s | 14.79 s |
| 3 min freeze + dead TCP + pending write: usable after wake | 2.53 s | 44.37 s | 44.38 s |

The last row is a specific failure case, not generic laptop wake. A [follow-up audit](../../latency-and-freeze/report.md) reproduced Herdr's slow path through a stuck shared SSH master: 13–47 s across three diagnostic trials. Removing the pending write reduced recovery to 4.77 s; externally forcing fresh SSH at wake reduced it to 4.72 s. Those controls use stock Herdr and do not replace or pool with the original measurements.

Corgi’s traffic falls **70% for sparse output** (256 → 78 kbit/s) and **50% for dense output** (708 → 354). All four arms deliver approximately 20 updates/s in those 1 Mbit/s cases.

With the same codec, Corgi still uses **2.03× the sparse traffic**, while using **20% less dense traffic**. Sparse upstream alone is 30.8 versus 11.0 kbit/s. Compression does not remove Corgi’s receipt exchanges or its three-frame/uncompressed-byte window. The latter remains a high-RTT bottleneck. [Existing receipt diagnosis](../../wire-efficiency/analysis.md), [frame window](../../../../../src/viewer_stream.ts).

**This is a measured prototype, not a production change.** The source has a 20 Hz ceiling; these are not maximum-throughput numbers. Caps apply per direction. Some inputs typed during disconnection are not delivered; the full receipt table retains those losses. No unexpected codec errors were observed. Adapter controls, ranges, input receipts, loss/jitter, directional outages and isolation results are in the [full measurements](measurements.md). [Reproduction playbook](README.md) · [raw archive](../../../../../dist/remote-zstd-e2e-20261108.tar.gz).
