# Main comparison tables

| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |
| --- | ---: | ---: | ---: |
| First uncached tab UI, 120 ms RTT: seconds ↓ | 2.52 | 2.42 | 3.96 |
| First pane content, same launch: seconds ↓ | 2.94 | 2.84 | 3.96 |
| Unseen tab, connected at 120 ms RTT: seconds ↓ | 0.133 | 0.134 | 0.127 |

| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |
| --- | ---: | ---: | ---: |
| Sparse 20 Hz, 120 ms RTT: total kbit/s ↓ | 256 | 80 | 79 |
| Dense 20 Hz, 120 ms RTT: total kbit/s ↓ | 710 | 357 | 874 |
| Dense 20 Hz, 600 ms RTT: updates/s ↑ | 3.2 | 20.0 | 20.0 |
| Dense 60 Hz, 300 ms RTT: updates/s ↑ | 6.2 | 59.9 | 23.6 |
| Dense at 64 kbit/s, 120 ms RTT: P95 age, seconds ↓ | 1.53 | 0.70 | 30.60 |
| Dense at 64 kbit/s, 600 ms RTT: P95 age, seconds ↓ | 1.32 | 1.80 | 30.65 |

| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |
| --- | ---: | ---: | ---: |
| 64 kbit/s → 1 Mbit/s: fresh within 10 s, seconds ↓ | 0.18 | 0.12 | — |
| 3-second outage, sparse: usable seconds ↓ | 2.77 | 3.08 | 0.81 |
| 35-second outage, sparse: usable seconds ↓ | 2.74 | 2.61 | 18.87 |
| 3-minute freeze, no pending write: usable seconds ↓ | 2.69 | 2.38 | 4.87 |
| 3-minute freeze + pending write: usable seconds ↓ | 2.62 | 2.46 | 44.78 |
