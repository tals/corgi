# Adaptive windows and freeze-recovery audit

This is a source/research investigation and an external diagnostic experiment.
No Corgi or Herdr application code was changed. The proposed controller below
has not been implemented or benchmarked; its acceptance tests are explicit.

## What is limiting Corgi

At 300 ms RTT the three-frame allowance limits a continuous stream to about
10 updates/s, even with unlimited bandwidth. The measured sparse stream reaches
9.9/s. Dense output reaches 6.53/s with zstd because the additional 16 KiB
uncompressed JSON budget fits approximately two of these updates. The experiment
changes an established path from 120 to 300 ms; the all-time minimum receipt RTT
continues to classify the slower path as queueing and keeps the smaller budget.
Compression runs after this accounting. [Source](../../../../src/viewer_stream.ts),
[measured results](../compression/end-to-end/evidence/main/summary.json).

The receipt is sent after decoding/reconstructing the frame, before painting it.
Thus the server is measuring transport plus receiver work, rather than a pure
network ping. It can continue coalescing unsent screen changes while a receipt is
outstanding. [Receipt path](../../../../src/machine_stream.ts).

## What live video and games actually borrow from

| System | Mechanism | What transfers to Corgi |
| --- | --- | --- |
| HLS-style live playback | Pipeline media parts and buffer playback; select bitrate variants to match available throughput | Pipeline enough work to cover RTT; measure time and rate rather than impose three application frames |
| Interactive WebRTC | Feedback-based rate control, paced sending, a rate/RTT-sized flight allowance, and queue-delay limits | Separate useful data in flight from excess queueing; lower production rate when delivery falls behind |
| Multiplayer snapshots | Sequenced current-state updates, an interpolation buffer, and deltas from a receiver-known baseline | Prefer current state to a FIFO of obsolete states; keep explicit baseline/sequence correctness |

Apple's low-latency HLS rules explicitly relate part duration to RTT and retain
multiple parts of playback headroom. Those parts contain many video frames; this
is not a three-frame ACK gate. Twitch documents multiple bitrate renditions for
different viewers. These are good models for rate adaptation and pipelining, but
their playback buffers are a poor latency target for an interactive terminal.
[Apple LL-HLS requirements](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/),
[Twitch enhanced broadcasting](https://help.twitch.tv/s/article/enhanced-broadcasting?language=en_US).

WebRTC's GoogCC implementation can calculate its byte window as target rate ×
(recent RTT + an allowance). Its recent feedback window is bounded, and it has
route-change handling, rate estimation and probing. Its pacer exposes queue-time
limits and instructs producers to skip encoding frames when queueing is excessive.
This is a useful pattern, not a reason to embed an entire second packet congestion
controller above TCP. [GoogCC source](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/goog_cc_network_control.cc),
[pacer source](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/pacing/pacing_controller.h).

Meta's published Facebook Live experiment couples measured application goodput
with adaptive video encoding over QUIC. Its newer Instagram Live ingest work
describes independent streams and media-object prioritization/drop policies.
Those transports can abandon obsolete media more selectively than a single
SSH/TCP byte stream. We can borrow their freshness objective while retaining SSH.
These are documented implementations, not a claim that every Twitch, TikTok or
Facebook client uses the same algorithm; TikTok's current controller was not
established by this investigation.
[Facebook Live/COPA](https://engineering.fb.com/2019/11/17/video-engineering/copa/),
[Instagram Live/MoQ](https://engineering.fb.com/2026/10/12/video-engineering/shipping-media-over-quic-at-meta-scale-for-instagram-live-ingest/).

In the snapshot model described by game-networking engineer Glenn Fiedler,
receivers reject old snapshots and interpolate between recent ones. Deltas can
reference the last acknowledged baseline while newer snapshots continue in
flight; acknowledgements do not require stop-and-wait rendering. This is a common
game architecture, not a rule for all multiplayer games. A terminal should not
interpolate invented text, and our chained reliable deltas cannot simply be
dropped after transmission.
[Snapshot interpolation](https://gafferongames.com/post/snapshot_interpolation/),
[snapshot compression](https://gafferongames.com/post/snapshot_compression/).

One useful caution from checking actual implementations: Valve's
`UnreliableNoDelay` interface documents dropping messages during connection setup,
but its current header explicitly says the desired excessive-queue-delay drop is
not implemented there. An API name alone is not evidence of congestion behavior.
[Valve source](https://raw.githubusercontent.com/ValveSoftware/GameNetworkingSockets/master/include/steam/steamnetworkingtypes.h).

## Recommended Corgi change

Use an adaptive application window **and** a queue-delay controller. TCP remains
responsible for packet congestion control and retransmission.

1. **Size flight allowance for the target cadence and current path.** A useful
   starting model is `ceil(target_updates_per_second × baseline_receipt_RTT) +
   jitter/processing headroom`. At 20 Hz and 300 ms, six frames are needed just to
   cover the round trip; roughly seven or eight is a sensible initial candidate.
   Grow the byte allowance alongside the frame allowance. Keep an independent
   hard memory limit, including the existing one-oversized-snapshot escape hatch.
2. **Control excess queueing separately.** Track receipt RTT, delivered rate,
   oldest outstanding age and local write backlog. Pace accepted updates; when
   delivery slows or delay grows, reduce accepted update rate and retain only the
   newest unsent screen. Do not manufacture an ever-larger allowance by multiplying
   the target cadence by an RTT inflated by congestion.
3. **Refresh the path baseline.** Replace the all-time fastest receipt with a
   finite-history estimator and explicit re-evaluation after reconnect/path
   changes. A persistent RTT rise needs a cautious drain/low-rate probe to
   distinguish a changed path from a standing queue. Merely expiring the minimum
   can otherwise normalize bufferbloat as the new baseline.
4. **Keep memory and network accounting distinct.** Raw JSON bytes bound memory
   and decode work. With integrated compression, emitted compressed bytes are
   the useful network-cost measurement. Do not assume that a fixed raw-byte cap
   is a network congestion window. Start with frame-size estimates for admission,
   then reconcile actual emitted bytes; permit a bounded one-frame overshoot.
5. **Preserve the existing correctness boundary.** Coalesce before delta encoding
   and compression. Keep accepted delta bases until they have been reconstructed.
   Bytes already admitted to TCP or a continuous zstd history cannot be selectively
   discarded. An abandoned transport needs fresh codec state and a new snapshot.

The distinction is physical: frames propagating across a healthy long path are
necessary work in flight; extra frames waiting behind a bandwidth bottleneck are
avoidable latency. A larger healthy window can still cause a longer transient
backlog after an abrupt bandwidth collapse. That tradeoff must be measured rather
than hidden behind a throughput score. For a genuinely wedged stream, testing a
fresh independent transport remains useful; another channel on the same SSH
master does not bypass its TCP queue.

The first implementation should be instrumented with emitted/acknowledged frame
counts, raw and compressed bytes, limiting reason (frame/byte/write queue), recent
and baseline receipt RTT, baseline age, delivery rate and oldest outstanding age.
Record periodic aggregates and changes through the existing telemetry machinery.
Receiver decode durations/inter-arrival intervals can improve estimates without
assuming synchronized client/server clocks.

Acceptance tests: steady 20/120/300/600 ms paths; both cold connections and RTT
steps in both directions; 1 Mbit/s → 64 kbit/s → 1 Mbit/s transitions; sparse,
dense and oversized snapshots; jitter/loss; paused ACKs; short and long outages;
client freeze. Compare 20 Hz delivery when capacity permits, wall-time p95 screen
age, input latency, memory and post-cap catch-up. Preserve exact reconstruction
and receipt checks. Test compression enabled and disabled. Seven or eight frames
at 300 ms is a calculated starting point, not a measured production fix.

## Herdr: what the 44-second number really measured

The original row combined three conditions: a three-minute process freeze,
server-side destruction of the existing SSH TCP connections, and a user input
sent immediately before freezing while downstream acknowledgements were blocked.
That pending write matters. The original three stock-Herdr trials had a 44.37 s
median, but that is not a general laptop-wake claim.

Twelve new diagnostic labs use the same unmodified Herdr v0.9.5 binary and normal
SSH `-C` compression. Each condition has three repetitions; all use real 180 s
freezes. These runs add SSH debug logs, TCP state and packet capture, so their
timings are diagnostic controls rather than replacements pooled into the earlier
untraced benchmark.

| Herdr condition | Usable after wake, median [range] |
| --- | ---: |
| Original: pending input + dead server TCP connection | 47.13 s [13.35–47.14] |
| Same, but no pending input before freeze | 4.77 s [4.75–4.80] |
| Original, but externally kill old client SSH processes at wake | 4.72 s [4.67–4.83] |
| Original, but do not force server TCP destruction | 14.70 s [7.13–17.04] |

The last condition does not guarantee a surviving application bridge: Herdr's
own idle/recovery mechanisms remain enabled. The fresh-SSH control is a deliberate
external intervention, not Herdr's default behavior or a patched Herdr build.
[Summary and ranges](evidence/summary.json), [individual trials](evidence/trials.json),
[564 audit checks](evidence/audit.json).

Herdr **does** have recovery mechanisms. Its client sends a health ping after
five quiet seconds, expires an unanswered ping after ten seconds, and reconnects.
Its remote bridge also has a 60-second idle watchdog. However, reconnecting the
application channel normally reuses a shared SSH master with `ControlMaster=auto`
and `ControlPersist=600`. Closing a channel does not close that master's TCP
connection. [Client health](</home/t/dev/personal/herdr-cpu-benchmark/source/src/client/endpoint/health.rs:3>),
[bridge watchdog](</home/t/dev/personal/herdr-cpu-benchmark/source/src/platform/remote_bridge.rs:8>),
[SSH options](</home/t/dev/personal/herdr-cpu-benchmark/source/src/remote/attach.rs:1231>),
[saved-machine reconnect](</home/t/dev/personal/herdr-cpu-benchmark/source/src/remote/saved.rs:15>).

In the fully traced `original-1` case:

| Time after wake | Observed event |
| --- | --- |
| +10.01 s | Application health check expires the selected endpoint |
| +10.54 s | Reconnect bootstrap explicitly tries the existing SSH master |
| approximately +25.54 s | The 15 s bootstrap timeout kills its SSH child |
| +27.14 to +40.74 s | That child is gone, but the old master still holds its stdout/stderr pipes; Herdr has pipe-reader threads waiting |
| +41.93 s | Old TCP connection finally retransmits its unacknowledged data |
| +42.05 s | Peer replies with TCP reset; old master disappears |
| +43.09 s | Next bootstrap opens a fresh connection |
| +46.62 / +47.13 s | Fresh screen / usable input echo |

The pending write left TCP in retransmission backoff. At wake, `ss` records
`backoff:7`, one unacknowledged segment and a roughly 41-second RTO. The packet
capture shows no traffic on that old connection between wake and its +41.93 s
retransmission. Different positions in that backoff explain why this is a
phase-sensitive outcome, including the much faster original-2 trial; the controls
do not establish an Internet-wide p95.
[TCP/packet and process recordings](../../../../dist/herdr-freeze-audit-v2-20261108/original-1/),
[post-wake packet excerpt](evidence/packets-after-wake.txt),
[bootstrap SSH log](evidence/bootstrap-ssh.txt),
[application log](evidence/herdr-client.txt).

There is a second delay amplifier in the timeout implementation. After killing
the bootstrap child, `wait_with_output_timeout` unconditionally joins its stdout
and stderr reader threads. With SSH multiplexing, the master also holds those
pipe descriptors. The child timeout therefore does not bound the complete call:
the pipe readers can remain blocked until the master closes them. The captured
descriptors identify the same two pipe inodes in Herdr and the master after the
child exits. [Timeout source](</home/t/dev/personal/herdr-cpu-benchmark/source/src/remote/process.rs:43>),
[descriptor proof](evidence/fd-proof.json), [SSH start times](evidence/ssh-starts-after-wake.json).

This establishes a concrete slow-recovery path in the measured release. It does
not establish that Herdr lacks reconnection, that every wake takes 44 seconds, or
that a new application channel is the same as a fresh TCP transport. The likely
fix in that path is an independent transport after a failed health check and a
timeout whose completion cannot depend on a surviving master's inherited pipes.
No Herdr patch was applied. The external fresh-SSH-at-wake control also bypasses
health-detection delay, so its 4.72 s result is not a prediction for a patch that
only changes transport choice after the ten-second health timeout.

Finally, SIGSTOP freezes processes while the Linux kernel and clocks continue.
It is not hardware suspend: Linux `CLOCK_MONOTONIC` excludes actual suspend,
whereas `CLOCK_BOOTTIME` includes it. TCP retransmission clocks, network state and
wake notifications can differ on a real laptop. The report now names the precise
failure case rather than presenting its result as generic laptop sleep behavior.
[Linux clock semantics](https://www.man7.org/linux/man-pages/man3/clock_gettime.3.html).
