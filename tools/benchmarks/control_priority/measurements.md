# Control isolation measurements

## Socket and codec isolation

Real daemon and pane producer at 50 Hz, 160×48. Three before/after trials;
six seconds sampled after 1.5 seconds of warmup. p95 values pool individual
observations; rates are medians of trial rates. A complete update requires
matching header/footer sequence numbers.

| Traffic | Steady control p95, before → after | Control p95 during 250 ms pane pause | Complete updates/s | Downstream KiB/s |
|---|---:|---:|---:|---:|
| Sparse, plain WS | 0.67 → 0.72 ms | 251.64 → 0.68 ms | 49.66 → 49.68 | 66.4 → 66.4 |
| Sparse, WS zstd | 1.29 → 1.30 ms | 252.43 → 1.03 ms | 49.74 → 49.69 | 2.8 → 2.6 |
| Dense, plain WS | 0.71 → 1.41 ms | 250.62 → 0.83 ms | 49.44 → 49.46 | 556.8 → 533.3 |
| Dense, WS zstd | 1.52 → 1.40 ms | 252.02 → 1.29 ms | 49.49 → 49.49 | 312.5 → 308.3 |

Downstream bytes include WS framing, measured by an external Unix-socket proxy.
The zstd rows also use Unix sockets and do not include SSH overhead. The pause
stops Bun's native reader as well as the Duplex wrapper. Control continues to
run: this is selective consumer backpressure, not application suspension.

Normal control latency remains small, but the dense/plain p95 increased by
0.70 ms in this run. These measurements do not establish identical CPU cost.
The deferred pane publication coalesces partial PTY writes, which can reduce
traffic without increasing the count of complete updates.
[Raw observations](evidence/local-trials.json) · [Summary](evidence/local-summary.json) ·
[Binary hashes and environment](evidence/local-manifest.json).

## Actual viewer over SSH

300 ms RTT, two 12-second samples per scenario, a 20 Hz producer, four panes
per machine, three daemons. The cap is applied once to the shared link by Linux
traffic control. Interface counters include SSH/TCP overhead. These runs test
frame rate and bandwidth regression; 1 Mbit/s is above this workload's demand.

| Scenario | Visible updates/s, before → after | Downstream kbit/s | Input → visible echo, median | Cap removed → fresh screen |
|---|---:|---:|---:|---:|
| Sparse, 1 Mbit/s | 20.0 → 20.0 | 49.0 → 48.9 | 353 → 341 ms | 190 → 179 ms |
| Dense, unrestricted | 20.0 → 20.0 | 325.2 → 325.0 | 364 → 357 ms | 177 → 176 ms |
| Dense, 1 Mbit/s | 20.0 → 20.0 | 325.1 → 325.6 | 345 → 350 ms | 160 → 190 ms |

Each cell's ten input probes executed once and appeared on screen. The
unrestricted row reapplies the same unconstrained path for its final freshness
check; it does not represent recovery from congestion. With only two trials,
small catch-up differences are not reliable tail estimates.
[Raw trials and independent input receipts](evidence/wan-trials.json) ·
[Ranges](evidence/wan-summary.json).

## Saturated shared link

The final build and baseline each ran twice at 300 ms RTT / 64 kbit/s, with
20-second windows. Existing telemetry measured `session.command` replies on the
actual viewer's control connection, independently of when echoed input appeared
in pane frames. Twenty measured command replies per version; no RPC failures,
no dropped telemetry events. Both sides used identical tracing.

| Metric | Before | After |
|---|---:|---:|
| Control acknowledgement median | 552 ms | 538 ms |
| Control acknowledgement p95 | 755 ms | 704 ms |
| Control acknowledgement maximum | 757 ms | 807 ms |
| Complete visible updates/s | 3.67 | 3.65 |
| Downstream traffic | 60.7 kbit/s | 60.3 kbit/s |
| Cap removed → fresh screen, median | 326 ms | 365 ms |
| Inputs executed once / visible | 10/10 | 10/10 |

This is not evidence of a substantial saturated-link latency improvement.
The network queue still adds delay beyond the 300 ms base RTT, even though
control no longer sits behind pane data in an application socket or codec.
The after-build's maximum was worse in this small sample. Strict link-level
priority would require additional pacing/QoS work; these results do not claim it.
[RPC spans, frame ages and independent receipts](evidence/pressure.json).

## Build provenance

The steady-state runs pin the two hashes in the manifests. The final test-drive
build additionally tracks a pending data handshake's age so control traffic
cannot hide a stuck data dial. This change is outside the already-established
stream path measured above; its real SSH reconnect tests are retained in
[reconnect.txt](evidence/reconnect.txt). Final build hashes and validation are
recorded in [validation.json](evidence/validation.json).

[Complete raw archive](../../../dist/control-priority-evidence.tar.gz) ·
[Archive SHA-256](evidence/archive.json) ·
[Saturation baseline manifest](evidence/pressure-before-manifest.json) ·
[Saturation candidate manifest](evidence/pressure-after-manifest.json).
