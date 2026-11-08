# High RTT and the Herdr freeze result

**Use an adaptive window, with queue-delay control.** At 20 updates/s and 300 ms
RTT, about seven or eight frames in flight is a reasonable starting candidate.
The byte allowance must grow too. This is a proposed fix, not a measured new
Corgi implementation.

The controller should distinguish propagation delay from a growing queue:
refresh its RTT baseline, pace accepted updates, reduce the update rate when
delivery falls behind, and retain only the latest unsent screen. A naive
`window = frame rate × current RTT` can grow the queue during congestion.
Compression and raw-memory budgets need separate accounting.
[Proposed controller and acceptance tests](analysis.md#recommended-corgi-change).

Live-media systems adapt rate and buffering; WebRTC is the closest model for our
latency target, with rate/RTT-sized flight allowance and queue-time control.
Multiplayer snapshot systems emphasize fresh state and decodable baselines.
We can borrow those principles while keeping SSH; changing transport is not
required to remove our artificial three-frame ceiling.
[Primary sources and distinctions](analysis.md#what-live-video-and-games-actually-borrow-from).

**The 44-second Herdr result needs a narrower label.** It measured a freeze with
both a dead TCP connection and an unacknowledged pending write. It is a real slow
path in the measured release, not a typical wake-up time. New stock-Herdr controls,
three trials each, with normal SSH compression:

| Condition | Usable after wake, median [range] |
| --- | ---: |
| Original failure case | 47.13 s [13.35–47.14] |
| Remove the pending input before freeze | **4.77 s [4.75–4.80]** |
| Force fresh client SSH connections at wake | **4.72 s [4.67–4.83]** |
| Do not force server TCP teardown | 14.70 s [7.13–17.04] |

Herdr has health checks and reconnects. The slow path reuses a **stuck SSH master**.
Its bootstrap child times out after 15 seconds, but the timeout handler waits for
stdout/stderr pipes still held by that master. In one trace, TCP finally retries
at +41.93 s, receives a reset at +42.05 s, and a fresh connection starts at +43.09 s.
[Source, packet timeline and pipe ownership proof](analysis.md#herdr-what-the-44-second-number-really-measured).

All application binaries remain unchanged. The forced-fresh-SSH row is a
diagnostic intervention. The experiment freezes processes, not a physical laptop;
kernel retransmission timers continue running. The original comparison now names
that limitation explicitly.
[Reproduce](README.md) · [raw results](evidence/summary.json) · [audit](evidence/audit.json).
