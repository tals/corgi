# Native WebSocket deflate: application comparison

**Native Bun deflate performs similarly to zstd in these application scenarios, but uses 21% more sparse traffic and 6% more dense traffic at equal 20 Hz output.** Its component CPU advantage becomes small at application level.

Cells: **total kbit/s / visible updates/s**, with 20 Hz input. All WS arms retain SSH. Caps are per direction; totals include both directions and network overhead. Three-trial medians; [ranges and evidence](measurements.md#streaming).

| Scenario | WS plain | WS zstd | WS native deflate | Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| Uncapped, 20 ms RTT, sparse | 371 / 20.0 | 82 / 20.0 | 99 / 20.0 | 84 / 20.0 |
| Uncapped, 20 ms RTT, dense | 1,028 / 20.0 | 359 / 20.0 | 381 / 20.0 | 877 / 20.0 |
| 1 Mbit/s, 120 ms RTT, sparse | 370 / 20.0 | 81 / 20.0 | 98 / 20.0 | 79 / 20.0 |
| 1 Mbit/s, 120 ms RTT, dense | 1,037 / 20.0 | 359 / 20.0 | 380 / 20.0 | 873 / 20.0 |
| 64 kbit/s, 120 ms RTT, sparse | 78 / 3.9 | 81 / 20.0 | 98 / 20.0 | 71 / 14.1 |
| 64 kbit/s, 120 ms RTT, dense | 72 / 1.2 | 73 / 4.0 | 78 / 3.9 | 68 / 1.2 |

“Usable” requires a fresh screen and input echo in the actual viewer. These outage rows use sparse output; [full results](measurements.md) include dense outages, navigation, loss and 600 ms RTT.

| Scenario | WS plain | WS zstd | WS native deflate | Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| First remote tab UI, cold / 120 ms RTT, s | 2.62 | 2.64 | 2.62 | 3.95 |
| First pane content, same launch, s | 3.03 | 3.13 | 3.07 | 3.95 |
| Dense 60 Hz, 300 ms RTT / 1 Mbit/s, updates/s | 14.6 | 59.9 | 59.1 | 23.6 |
| Dense 64 kbit/s / 120 ms RTT, P95 screen age, s | 2.36 | 0.67 | 0.71 | 30.61 |
| After 64 kbit/s → 1 Mbit/s, first fresh screen, s | 0.21 | 0.11 | 0.16 | none within 10 s |
| After 3 s outage, usable, s | 3.30 | 2.68 | 3.03 | 1.27 |
| After 35 s outage, usable, s | 2.86 | 2.81 | 2.83 | 13.56 |
| After 180 s freeze, no pre-freeze input, usable, s | 2.81 | 2.53 | 2.57 | 4.79 |
| After 180 s freeze, input before freeze, usable, s | 2.91 | 2.68 | 2.69 | 44.34 |

Dense 20 Hz **application + SSH + bridge CPU** was **0.244 cores with zstd versus 0.238 with native deflate**, with overlapping trial ranges. Herdr used 0.109 cores. This includes Herdr’s SSH compression. [CPU breakdown and limits](measurement-checks.md#cpu-includes-the-compression-process).

Most extra sparse traffic is upstream: Bun leaves small client messages uncompressed. Zstd with raw-byte controller accounting also delivered **59.1 updates/s**, so the small cadence gap is not a codec-speed result. [Measurement controls](measurement-checks.md).

Two qualifications: [initial queue drain affects severe-link P95](backpressure.md), and [Herdr’s long freeze recovery depends on TCP state](../websocket_app/sleep-interpretation.md). Both remain in the reported results.

**Evidence:** [180/180 labs and 6,488 audit checks passed](evidence/audit.json); [143 codec/packet checks](evidence/proof.json). Packet sums matched bandwidth counters within 1.02%. Herdr is unpatched. WS+zstd is an application subprotocol; native deflate uses the standard extension with history.

**Scope:** evaluation builds only; production source is unchanged. WS daemon handoff and oversized compressed-burst handling still need production work. [Reproduction playbook](README.md) · [Detailed tables](tables.md) · [Exact builds](evidence/builds.json).
