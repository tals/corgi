# Control traffic isolation

**Built: separate control and pane-data WS connections, locally and remotely.**
Remote data also uses an independent SSH transport. Pane backpressure no longer
blocks control in the same socket or compression queue.

| Measurement | Before | After |
|---|---:|---:|
| Dense output, pane reader paused 250 ms: local control reply p95 | 250.6 ms | **0.83 ms** |
| Same pause, WS + zstd transport: control reply p95 | 252.0 ms | **1.29 ms** |
| Real SSH, dense output, 300 ms RTT / 1 Mbit/s: visible updates/s | 20.0 | 20.0 |
| Same SSH scenario: downstream traffic | 325.1 kbit/s | 325.6 kbit/s |
| Same scenario, cap removed → fresh screen | 160 ms | 190 ms |
| Saturated 64 kbit/s SSH link: control acknowledgement p95 | 755 ms | 704 ms |

The pause measurements isolate the WS/codec queues over Unix sockets; they are
not WAN latency or whole-process suspend measurements. Three trials per case,
24 pauses per cell. WAN results are medians of two 12-second trials through a
shared link cap, using the actual viewer and OpenSSH. All 30 input probes per
version executed once and appeared on screen across the three WAN scenarios.
[Transport evidence](evidence/local-summary.json) · [WAN evidence and ranges](evidence/wan-summary.json).

**Saturation is still a limit.** At 64 kbit/s, this did not establish a meaningful
control tail-latency improvement. Both versions delivered about 3.7 updates/s
and 60 kbit/s; all ten input probes per version executed once and appeared.
The split removes pane queue blocking, but cannot preempt bytes already queued
on the shared network. [Actual control RPC spans](evidence/pressure.json).

Control includes input, command replies, configuration/receipts and unsolicited
focus/relaunch commands. Pane frames, streamed metadata and bulk reads use data.
Adaptive frame limits remain in place. Both remote handshakes start together;
each lane's progress is checked independently. Local traffic stays uncompressed.
Older peers without the new capabilities keep the existing stream.
[Implementation](../../../src/viewer_data.ts) · [Protocol details](../../../HACKING.md#change-protocols-or-saved-formats).

This costs an extra WS connection and, remotely, a separate SSH transport. The
physical link and daemon CPU remain shared; this does not provide network QoS.

[Detailed measurements](measurements.md) · [Validation](evidence/validation.json) ·
[Reproduction playbook](README.md).
