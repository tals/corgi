# Corgi zstd + adaptive windows versus stock Herdr

Follow-up: [production review, committed fixes, and new measurements](review/report.md).

Implemented in Corgi: **live-history zstd, adaptive frame/byte budgets, pipelined
connection setup, and reconnect-safe live upgrades**. No trained dictionary;
Herdr v0.9.5 is unmodified and uses installed SSH compression.
[Implementation](implementation.md) · [Transport proof](evidence/transport.json).

Three repetitions per scenario; **126 isolated labs**, including the extra
high-latency/low-bandwidth case. Values below are medians. Links in the
[complete measurements](measurements.md) lead to each original trial and its
range. “Before” is the preceding Corgi throughput implementation, without this
integrated zstd/controller change.

| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |
| --- | ---: | ---: | ---: |
| First uncached tab UI, 120 ms RTT: seconds ↓ | 2.52 | 2.42 | 3.96 |
| First pane content, same launch: seconds ↓ | 2.94 | 2.84 | 3.96 |
| Unseen tab, connected at 120 ms RTT: seconds ↓ | 0.133 | 0.134 | 0.127 |

Launch timings include remote selection and terminal-probe fallback waits.
The UI/content rows use a fresh layout cache; cached startup is separate in the
[full table](measurements.md#startup).

| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |
| --- | ---: | ---: | ---: |
| Sparse 20 Hz, 120 ms RTT: total kbit/s ↓ | 256 | 80 | 79 |
| Dense 20 Hz, 120 ms RTT: total kbit/s ↓ | 710 | 357 | 874 |
| Dense 20 Hz, 600 ms RTT: updates/s ↑ | 3.2 | 20.0 | 20.0 |
| Dense 60 Hz, 300 ms RTT: updates/s ↑ | 6.2 | 59.9 | 23.6 |
| Dense at 64 kbit/s, 120 ms RTT: P95 age, seconds ↓ | 1.53 | 0.70 | 30.60 |
| Dense at 64 kbit/s, 600 ms RTT: P95 age, seconds ↓ | 1.32 | 1.80 | 30.65 |

Throughput rows use a 1 Mbit/s cap unless stated otherwise. Caps apply per
direction; traffic totals include both directions. Dense traffic is **59% lower
than Herdr** at roughly 20 updates/s. Sparse traffic is now roughly equal:
Corgi saves downstream bytes but still spends **31.5 versus 5.7 kbit/s upstream**.
At 60 Hz, P95 display age is **0.18 versus 6.07 seconds**.
[Streaming evidence](measurements.md#streaming).

| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |
| --- | ---: | ---: | ---: |
| 64 kbit/s → 1 Mbit/s: fresh within 10 s, seconds ↓ | 0.18 | 0.12 | — |
| 3-second outage, sparse: usable seconds ↓ | 2.77 | 3.08 | 0.81 |
| 35-second outage, sparse: usable seconds ↓ | 2.74 | 2.61 | 18.87 |
| 3-minute freeze, no pending write: usable seconds ↓ | 2.69 | 2.38 | 4.87 |
| 3-minute freeze + pending write: usable seconds ↓ | 2.62 | 2.46 | 44.78 |

“Usable” requires fresh content and an input echo; recovery starts when the
fault ends. “—” means Herdr did not reach fresh content within the ten-second
post-cap observation. Freeze tests suspend client processes, drop packets and
kill server TCP state; **44.78 s is the pending-write failure path, not normal
wake-up behavior**. [Recovery evidence](measurements.md#recovery) ·
[Herdr source/packet audit](../latency-and-freeze/analysis.md).

**Remaining gaps:** brief outages favor Herdr; at 600 ms/64 kbit/s the new window
increases Corgi's P95 age from **1.32 to 1.80 s**, despite delivering more updates.
With 1% loss, Corgi delivers **17.2 versus Herdr's 19.6 updates/s**. CPU/RSS also
remain higher. These are retained results, not excluded trials.
[Limits and resource measurements](implementation.md#limits-and-next-bottlenecks).

**Validation:** 3,386 unit tests and 98 integration tests passed; one intentional
skip in each suite. Typecheck/format passed. Both benchmark audits passed, and
all test namespaces were removed. [Logs](evidence/validation.json).

[Reproduce](README.md) · [Raw evidence archive](../../../../dist/corgi-adaptive-evidence-20261108.tar.gz)
· [Main audit](evidence/audit.json) · [Edge audit](evidence/edge/audit.json)
