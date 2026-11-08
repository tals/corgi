# Main comparison tables

| Scenario / metric | WS uncompressed | WS zstd | WS native deflate | Stock Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| First uncached tab UI, 120 ms RTT: seconds ↓ | 2.62 | 2.64 | 2.62 | 3.95 |
| First pane content, same launch: seconds ↓ | 3.03 | 3.13 | 3.07 | 3.95 |
| Unseen tab, connected at 120 ms RTT: seconds ↓ | 0.138 | 0.134 | 0.135 | 0.132 |

| Scenario / metric | WS uncompressed | WS zstd | WS native deflate | Stock Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| Sparse 20 Hz, 120 ms RTT: total kbit/s ↓ | 370 | 81 | 98 | 79 |
| Dense 20 Hz, 120 ms RTT: total kbit/s ↓ | 1037 | 359 | 380 | 873 |
| Dense 20 Hz, 600 ms RTT: updates/s ↑ | 20.1 | 20.0 | 20.0 | 20.0 |
| Dense 60 Hz, 300 ms RTT: updates/s ↑ | 14.6 | 59.9 | 59.1 | 23.6 |
| Dense at 64 kbit/s, 120 ms RTT: P95 age, seconds ↓ | 2.36 | 0.67 | 0.71 | 30.61 |
| Dense at 64 kbit/s, 600 ms RTT: P95 age, seconds ↓ | 4.37 | 3.05 | 3.45 | 30.31 |

| Scenario / metric | WS uncompressed | WS zstd | WS native deflate | Stock Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| 64 kbit/s → 1 Mbit/s: fresh within 10 s, seconds ↓ | 0.21 | 0.11 | 0.16 | — |
| 3-second outage, sparse: usable seconds ↓ | 3.30 | 2.68 | 3.03 | 1.27 |
| 35-second outage, sparse: usable seconds ↓ | 2.86 | 2.81 | 2.83 | 13.56 |
| 3-minute freeze, no pre-freeze input: usable seconds ↓ | 2.81 | 2.53 | 2.57 | 4.79 |
| 3-minute freeze + input before freeze: usable seconds ↓ | 2.91 | 2.68 | 2.69 | 44.34 |
