# WebSocket transport experiment

**With the same zstd stream, WebSocket adds little downstream traffic. Native
WebSocket deflate uses less CPU here, with a larger bandwidth cost—especially
for sparse output and acknowledgments.** This is a component result; the
[application experiment](../websocket_app/) measures actual Corgi behavior.

Both-direction TCP payload, including receipts and WS frame headers, excluding
HTTP upgrade, TCP/IP and SSH. Full traces; medians of seven trials:

| Trace | TCP + zstd | WS + same zstd | WS native deflate |
|---|---:|---:|---:|
| Dense | 406.96 KiB | 409.39 KiB | 423.63 KiB |
| Sparse | 20.56 KiB | 22.55 KiB | 30.12 KiB |
| Claude | 5.94 KiB | 6.33 KiB | 7.44 KiB |
| Codex | 8.97 KiB | 9.61 KiB | 12.41 KiB |

Combined **post-open endpoint CPU per message**, including framing, verification
and receipts; process startup, upgrade and initial codec construction excluded.
This repeat ran after the other task benchmarks finished; sampled SMT siblings
averaged below 0.5% CPU ([scheduling evidence](evidence/loopback/cpu-context.json),
[utilization samples](evidence/loopback/cpu-utilization.json)):

| Trace | TCP + zstd | WS + same zstd | WS native deflate |
|---|---:|---:|---:|
| Dense | 386 µs | 372 µs | 130 µs |
| Sparse | 283 µs | 295 µs | 59 µs |
| Claude | 443 µs | 507 µs | 94 µs |
| Codex | 405 µs | 456 µs | 84 µs |

The zstd payload bytes match **exactly** between transports. WS headers add
0.26–3.2% downstream, or 0.6–9.7% counting both directions. Native WS deflate adds
4.1–46.5% both-direction traffic versus TCP+zstd: Bun leaves the small client
receipts uncompressed. Its lower CPU measures the integrated native path, not
proof that the deflate algorithm itself is faster than zstd.
[Full sizes, medians and ranges](evidence/summary.json),
[all scenarios and modes](evidence/tables.md).

| Controlled scenario | TCP + zstd | WS + same zstd | WS native deflate |
|---|---:|---:|---:|
| Dense, 300 ms RTT / 1 Mbit/s: delivered messages/s | 45.4/s | 45.4/s | 45.3/s |
| Same path: first complete message | 330 ms | 636 ms | 631 ms |
| 1-second downstream hold: receipt P95 | 1009 ms | 1009 ms | 1003 ms |
| Fresh connection after deliberate drop, 30 ms RTT: first content | 34.0 ms | 66.3 ms | 65.5 ms |

WS adds an HTTP upgrade round trip in this harness. The traffic hold/reconnect
cases preserve exact bytes and reset compression history successfully; they do
not implement Corgi coalescing, rendering baselines or sleeping-client recovery.
The network conditions above use a FIFO userland proxy, not kernel netem.

**Evidence:** [316 validated trials](evidence/validation.json),
[loopback raw trials](evidence/loopback/trials.json),
[shaped raw trials](evidence/shaped/trials.json),
[environment and source hashes](evidence/loopback/environment.json),
[held-out corpus hashes](fixtures/manifest.json).

[Reproduction commands and precise accounting](README.md).
There is no native zstd WS extension in the installed Bun; WS+zstd here means
binary application compression with native WS compression disabled.
[Capability checks](../websocket_app/capabilities.md).
