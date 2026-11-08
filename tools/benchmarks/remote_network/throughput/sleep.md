# Three-minute client freeze

Median [min–max], seconds from client resume to remotely echoed usable input. Three fresh labs per product, with CPU rotation.

| Product | Recovery |
| --- | ---: |
| before | 2.597 [2.587–2.613] |
| after | 2.614 [2.585–2.614] |
| herdr | 46.293 [46.105–46.513] |

The pending input executes once in every trial; all eight remote producers retain their PIDs and advance CPU counters while the client is stopped. [Results, continuity and checks](evidence/sleep-control.json).

The harness queues an input with downstream ACKs blocked, applies SIGSTOP to all client-side processes, kills the old SSH TCP connections while packets are dropped, then resumes the client and restores networking after 180 seconds. This is not physical laptop suspend. Herdr’s 46-second result is specific to this rerun; the older one-off sleep measurements were much faster and are not pooled here.

A [later diagnostic audit](../latency-and-freeze/report.md) isolated a slow path: the pending write leaves the shared SSH master in TCP retransmission backoff, and reconnect bootstrap reuses that master. Its timeout also waits on pipes retained by the master. Removing the pending write reduced stock-Herdr recovery to 4.77 s median; retry phase produced a 13–47 s range with the original failure conditions. These are conditional failure-case results, not general laptop wake times.

[Reproduction](README.md#additional-bandwidth-and-sleeping-client-comparisons).
