# Three-minute client freeze

Median [min–max], seconds from client resume to remotely echoed usable input. Three fresh labs per product, with CPU rotation.

| Product | Recovery |
| --- | ---: |
| before | 2.597 [2.587–2.613] |
| after | 2.614 [2.585–2.614] |
| herdr | 46.293 [46.105–46.513] |

The pending input executes once in every trial; all eight remote producers retain their PIDs and advance CPU counters while the client is stopped. [Results, continuity and checks](evidence/sleep-control.json).

The harness applies SIGSTOP to all client-side processes, kills the old SSH TCP connections while packets are dropped, then resumes the client and restores networking after 180 seconds. This is not physical laptop suspend. Herdr’s 46-second result is specific to this rerun; the older one-off sleep measurements were much faster and are not pooled here. The reason for that historical difference was not isolated in this throughput investigation.

[Reproduction](README.md#additional-bandwidth-and-sleeping-client-comparisons).
