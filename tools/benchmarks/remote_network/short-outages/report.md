# Short outages: why Corgi trails Herdr

**The three-second gap is TCP retransmission delay. No new application fix is
retained from this investigation.** The earlier long-outage fixes remain committed.

| Configured outage | Corgi | Herdr |
| --- | ---: | ---: |
| 2 s | 1.07 s | 0.70 s |
| 3 s | 2.66 s | 0.97 s |
| 4 s | 1.67 s | 2.62 s |
| 5 s | 0.75 s | 2.57 s |
| 7 s | 3.52 s | 1.06 s |

Median time from restoration to remote input echo; three independent trials,
120 ms RTT, unchanged Herdr v0.9.5. Herdr's three-second lead is **1.69 s**.
The winner changes with TCP retry timing; ranges matter, especially at seven
seconds. [All trials and ranges](measurements.md).

Corgi acknowledges each decoded frame to bound stale output on slow links.
That leaves application data outstanding in both TCP directions. Separate
captures locate the wait inside TCP: **2.05 s without a packet sent on Corgi's
old connection** after restoration; Herdr's retry lands at +0.095 s. Neither
product reconnects in that diagnostic. [Packet evidence and source analysis](diagnosis.md).

Earlier SSH probes gave no meaningful improvement; larger windows worsened
the three-second case. Removing receipts reached **1.32 s**, but removed the
backpressure bound and worsened five-second recovery. A preauthenticated spare
helped at three seconds but regressed at seven. I rejected all four as
production fixes.
[Experiments and tradeoffs](diagnosis.md#controlled-changes-including-unsuccessful-fixes).

The corrected sweep passes all **819 audit checks** across 45 outage cases.
I fixed a harness timing bug: TCP snapshots now run independently of restoration;
observed windows are within 0.09 s of configured durations. Earlier trials are
retained separately. Unit tests: 3,372 pass; typecheck passes.
[Audit](evidence/audit.json) · [Validation](evidence/validation.json) ·
[Reproduce](README.md) · [Raw archives](evidence/artifacts.json).
