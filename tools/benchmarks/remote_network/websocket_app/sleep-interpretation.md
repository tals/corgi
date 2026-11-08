# Interpreting Herdr's freeze result

Use the current measured **13.42 s [13.03–13.74]** for Herdr's usable recovery after the three-minute freeze with a pre-freeze input write. The previous standard experiment measured **44.78 s [13.47–47.00]** with the same Herdr binary and identical relevant harness files. The earlier data already included a 13-second result; 44 seconds was never a universal recovery time. [Retained comparison and hashes](evidence/sleep-interpretation.json).

Earlier packet-instrumented controls independently demonstrated both outcomes with unacknowledged TCP data:

| Prior traced trial | TCP state near wake | First old-connection retry / reset after wake | Usable |
|---|---|---:|---:|
| original-1 | 1 unacknowledged segment, backoff 7, RTO 41.344 s | 41.93 / 42.05 s | 47.13 s |
| original-2 | 1 unacknowledged segment, backoff 6, RTO 20.864 s | 8.77 / 8.89 s | 13.35 s |

Those traces establish a recovery path sensitive to the retransmission timer's phase: a reused SSH master can remain stuck until TCP retries and discovers the destroyed server connection. [Earlier analysis and source proof](../latency-and-freeze/analysis.md#herdr-what-the-44-second-number-really-measured), [extracted packet timings](evidence/sleep-interpretation.json).

In the current three trials, the freeze lasted 180.14–180.35 seconds; the pending input was received exactly once before freezing; and the old Atlas SSH process remained visible until approximately 7.74–8.65 seconds after wake. This is consistent with the earlier fast branch. **These runs have no TCP snapshots or packet capture, so the precise current timer state and unacknowledged-segment precondition are not independently proven.** An application input receipt does not prove TCP acknowledgement status.

A suspected shaping gap is not established either: on the same kernel, applying the harness's exact root TBF replacement in a private namespace retained the child netem rule at 100% loss before another netem command ran. That result argues against attributing the difference to removal of that child rule. The probe's before/after state is retained in the [evidence](evidence/sleep-interpretation.json).
