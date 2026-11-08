# Main comparison tables

| Scenario / metric | Corgi direct | Corgi WebSocket | Corgi raw-adapter | Stock Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| First uncached tab UI, 120 ms RTT: seconds ↓ | 2.40 | 2.54 | 2.43 | 3.94 |
| First pane content, same launch: seconds ↓ | 2.84 | 2.98 | 2.86 | 3.94 |

| Scenario / metric | Corgi direct | Corgi WebSocket | Corgi raw-adapter | Stock Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| Sparse 20 Hz, 120 ms RTT: total kbit/s ↓ | 80 | 81 | 79 | 79 |
| Dense 20 Hz, 120 ms RTT: total kbit/s ↓ | 358 | 359 | 357 | 873 |
| Dense 20 Hz, 600 ms RTT: updates/s ↑ | 20.0 | 20.0 | 20.0 | 20.0 |
| Dense 60 Hz, 300 ms RTT: updates/s ↑ | 60.0 | 59.9 | 59.9 | 23.6 |
| Dense at 64 kbit/s, 120 ms RTT: P95 age, seconds ↓ | 0.70 | 0.69 | 0.66 | 30.71 |
| Dense at 64 kbit/s, 600 ms RTT: P95 age, seconds ↓ | 0.99 | 1.00 | 0.99 | 30.22 |

| Scenario / metric | Corgi direct | Corgi WebSocket | Corgi raw-adapter | Stock Herdr + SSH-C |
| --- | ---: | ---: | ---: | ---: |
| 64 kbit/s → 1 Mbit/s: fresh within 10 s, seconds ↓ | 0.17 | 0.08 | 0.19 | — |
| 3-second outage, sparse: usable seconds ↓ | 3.16 | 3.13 | 3.02 | 0.92 |
| 35-second outage, sparse: usable seconds ↓ | 2.69 | 2.74 | 2.64 | 17.71 |
| 3-minute freeze, no pending write: usable seconds ↓ | 2.35 | 2.48 | 2.37 | 4.67 |
| 3-minute freeze + pending write: usable seconds ↓ | 2.48 | 2.62 | 2.47 | 13.42 |
