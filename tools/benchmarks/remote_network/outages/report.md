# Updated remote branch: outage recovery

**Rebased onto `455a941b`; fixed the long recovery gaps.** After a 35-second
outage, median recovery fell **10.14 → 3.51 s**. The worst of three recoveries
after a 60-second outage fell **17.56 → 3.45 s**.
[All trials and ranges](measurements.md).

| Outage → usable input | Rebased Corgi before | Corgi fixed | Herdr |
| --- | ---: | ---: | ---: |
| 3 seconds | 2.41 s | 2.39 s | 0.89 s |
| 15 seconds | 3.28 s | 3.17 s | 11.45 s |
| 35 seconds | 10.14 s | 3.51 s | 14.39 s |
| 60 seconds | 2.95 s | 2.65 s | 19.88 s |

Medians of three independent trials per product, at 120 ms RTT. Real viewers,
SSH and workloads run in isolated network namespaces; CPU assignments rotate
between products. Performance trials disable telemetry. Herdr v0.9.5 is
unmodified. Tested Corgi revisions: `1b41f5ad` → `35cef14d`.
[Evidence](evidence/summary.json) · [675-check audit](evidence/audit.json).

**Cause:** a primary timeout killed the spare SSH handshake, and recovery
probes stopped while reconnecting or waiting in retry backoff. One recorded
outage left approximately 15 seconds without a fresh SSH attempt after the
network returned. The fix preserves the spare and continues bounded,
latency-aware probing during recovery. The existing telemetry now records
connection phases, RPC timings and SSH child IDs, with a timeline filter.
[Diagnosis and linked traces](diagnosis.md).

**Rebase regression fixed:** the updated predictive-typing receipts could be
consumed by a frame rejected under backpressure. Receipts now remain pending
until their frame is accepted. Integration assertions also follow the updated
connection headers. [Regression evidence](evidence/receipt-before.txt) ·
[Implementation](../../../../src/viewer_protocol.ts).

**Still open:** Herdr retains its short-outage advantage. The 3- and 15-second
medians changed little. Three trials do not establish a universal recovery
bound; the fix makes more connection attempts during prolonged outages.
The older bandwidth/suspend matrix remains historical.

**Validation:** 3,372 unit tests and 70 integration tests pass; 300 ms RTT
startup passes 6/6 attempts, and bandwidth/loss probes pass 15/15.
[Validation](evidence/validation.json) · [Reproduction playbook](README.md) ·
[Raw evidence and hashes](evidence/artifacts.json)
