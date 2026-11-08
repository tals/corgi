# Throughput, recovery and bandwidth

**Committed `9eff77f4`: dense output at 1 Mbit/s and 120 ms RTT improves from 13.97 to 19.97 updates/s (+43%), essentially matching Herdr.** Corgi allows a larger byte budget while receipts are quick, then falls back when they slow down. The three-frame ceiling remains.

Bandwidth is a mixed result. At 1 Mbit/s and 120 ms RTT:

| Output | Corgi total kbit/s | Herdr total kbit/s | Efficiency |
| --- | ---: | ---: | --- |
| Dense, ~20 updates/s | 709 | 873 | Corgi uses 19% less |
| Sparse, 20 updates/s | 256 | 79 | Corgi uses **3.23× more** |

Both directions, including transport/control traffic. Sparse screen lag is nearly identical. **Sparse bandwidth efficiency remains unresolved.** [Bandwidth evidence and likely contributors](bandwidth.md).

| Recovery / backpressure metric | Corgi before | Corgi after | Herdr |
| --- | ---: | ---: | ---: |
| Dense 64 kbit/s: p95 screen lag | 1.53 s | 1.54 s | 30.86 s |
| Catch-up after lifting that cap | 0.13 s | 0.21 s | 0.88 s |
| Dense 3 s outage: usable input | 2.66 s | 2.77 s | 3.85 s |
| Dense 35 s outage: usable input | 2.60 s | 3.10 s | 13.40 s |

The throughput gain has a recovery cost: dense 3–5-second outages add roughly 0.11–0.15 seconds; the 35-second median rises 0.50 seconds, with overlapping ranges. Three-minute client-freeze recovery stays near 2.6 seconds. [All trials and ranges](measurements.md) · [Client freeze](sleep.md) · [Packet diagnosis](diagnosis.md).

Other gaps remain: after RTT rises from 120 to 300 ms, Corgi retains the smaller budget and delivers 6.2 updates/s versus Herdr’s 20. Sparse three-second outage recovery remains slower too: 2.69 versus 1.29 seconds. These results are not presented as universal parity.

Three independent trials per scenario, real SSH, externally shaped networks and unmodified Herdr v0.9.5. All final audits pass. Validation: 3,375 unit tests passed, one skipped; typecheck and 70 integration tests passed.
[Validation](evidence/validation.json) · [Reproduce](README.md) · [Raw archives](evidence/artifacts.json).
