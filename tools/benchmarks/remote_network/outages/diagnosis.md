# Why recovery stalled

The delay occurs in connection establishment and retry policy. There are two
separate paths to a long wait, both visible outside the application and in the
opt-in recorder.

## A timed-out request discarded a useful spare

In the pre-fix 30-second diagnostic, the viewer started a spare connection about
8 seconds into the outage. At about 12 seconds, the primary RPC timed out and
`disconnect()` closed that spare too. The new primary then spent **21.66 s**
waiting for its `hello`, including the remaining outage and TCP/SSH setup.
The spare-recovery loop only ran for `stalled` endpoints, so it could not help
this endpoint while its state was `connecting`.

Relative to link restoration, the trace shows:

| Event | Seconds |
| --- | ---: |
| Primary timeout; spare closed; new primary starts | −18.21 |
| SSH bridge ready | +3.35 |
| `hello` returns | +3.45 |
| Link resumed | +3.58 |
| Session snapshot received | +3.83 |
| Fresh screen presented | +3.97 |
| Remote input echo observed | +4.14 |

The recorder and the external fault harness share epoch timestamps; the
retained TCP records include retransmissions and enlarged retry intervals.
This diagnostic is separate from the telemetry-disabled performance matrix.
[Full pre-fix timeline and TCP samples](evidence/before-timeline.json).

## Retry backoff created a period with no attempt in flight

The telemetry-disabled `before-2` run took **17.56 s** to recover from its
60-second outage. Its resource samples show the last fresh Atlas SSH process
at −0.90 s, no fresh Atlas SSH attempt at samples from +0.29 through +14.19 s, and a
new process at +15.37 s. The sampling interval is about 1.2 seconds, so these
are observations, not exact spawn/exit timestamps.
[Process observations and the measured result](evidence/retry-gap.json).

That gap matches the endpoint's exponential retry delay, capped at 15 seconds.
Previously, an endpoint in `offline` backoff or `connecting` could not start a
spare race. Failed dials also reset the task-start timestamp used to measure
silence, postponing further probing even though no traffic had arrived.
[Retry scheduling and recovery eligibility](../../../../src/machine_connection.ts).

## What changed

The primary can time out without killing a spare already in progress. A spare
that receives a valid `hello` can take over while the endpoint reconnects or
waits to retry. A previously connected endpoint continues probing based on its
last received traffic, rather than treating each failed dial as progress.

There is at most one spare alongside the primary. Initial stall detection and
its first race keep the latency-adaptive threshold. During an established
connection's recovery, probes are spaced by one stall budget (at least 4 s).
Spare handshakes have the learned request timeout, capped at 30 s; initial
connections retain their original startup allowance. Pause, manual retry and
close cancel both paths. Commands still resume through the numbered link, so
this change does not blindly replay input.

The final diagnostic confirms both takeover paths. In its 35-second outage,
probes continued while reconnecting and one won at +1.89 s after restoration.
In its 60-second outage, a probe won while the primary was waiting in backoff.
[Final phases, RPC timings and TCP records](evidence/after-timeline.json).

The tradeoff is more connection attempts during a prolonged outage. The
three-trial comparison tests a few fixed restoration phases; it cannot
establish a universal recovery bound. TCP retransmission still explains the
short-outage gap, where the connection can resume without a fresh SSH handshake.
[Comparison and ranges](measurements.md).

The new deterministic SSH regression strands the first reconnect handshake.
It fails on the rebased pre-fix binary and succeeds with the fix, preserving
the remote process and delivering the final marker once.
[Failing regression](evidence/hung-reconnect-before.txt) ·
[Final validation](evidence/validation.json).
