# Why throughput improves, and what it costs

The old 16 KiB budget often admitted only two dense render frames. A representative
132 × 47 dense update encodes to 5,562 bytes in the [offline reproduction](evidence/frame-size.json), including the envelope allowance;
three exceed 16 KiB. Receipts take a round trip, so a two-frame window at 120 ms
cannot sustain a 20 Hz producer. The matched baseline delivers 13.97 updates/s
at 1 Mbit/s while using only 452 kbit/s downstream. The candidate delivers 19.97
updates/s and uses 655 kbit/s. Herdr delivers 20.00 and uses 844 kbit/s.
[All three trials](stream-120/evidence/trials.csv).

The [implementation](../../../../src/viewer_stream.ts) raises the budget to 32 KiB
while receipts stay within 50 ms of the stream's fastest observed receipt. It
returns to 16 KiB when receipt delay increases. It always caps outstanding frames
at three, retains the oversized-snapshot exception, and builds the next delta
against the last **accepted** frame. No wire changes or Herdr modifications are
needed. The timing baseline is scoped to a stream; a permanent increase in base
RTT can leave it at the smaller budget until that stream is replaced.

A simpler fixed-32-KiB pilot also reached 20 updates/s, but increased dense
256 kbit/s p95 lag from 0.36 to 0.49 seconds and 64 kbit/s lag from 1.53 to 2.05
seconds. That is why the shipped change includes fallback. Those are single-run
pilot pairs, excluded from the repeated comparison.
[Pilot evidence](evidence/pilots.json).

The separate telemetry run records fallback at 256 kbit/s when a receipt takes
213 ms against a 126 ms baseline, and at 64 kbit/s when it takes 432 ms against
127 ms. After the cap is removed, fast receipts reopen the larger budget.
There are also brief fallbacks during the 1 Mbit/s trace; the policy reacts to
receipt delay, not the configured bandwidth label.
[Window transitions with network timestamps](evidence/window-events.json).

## Recovery tradeoffs

Across three matched trials, dense 3-, 4- and 5-second outages add 0.110, 0.132
and 0.154 seconds to median usable-input recovery. Dense 35-second recovery rises
from 2.599 to 3.101 seconds, with candidate range 2.591–3.539 seconds. The measured
increase remains in the report; three trials do not establish its universal size.
[Sparse and dense results](measurements.md#outage-recovery).

Separate packet diagnostics reproduce the short-outage cost on the existing TCP
connection. After a three-second loss, the first Atlas transmission is at +2.220
seconds before versus +2.310 after; a fresh screen arrives at +2.346 versus +2.495.
After five seconds of loss, Atlas first transmits at +0.186 versus +0.323; the
fresh screen arrives at +0.376 versus +0.508. In these captures, the extra delay
is largely visible before the server sends again. This supports a change in TCP
retransmission/acknowledgement timing as a contributor, rather than attributing
the full difference to application snapshot work. These are diagnostic samples,
not additional timing trials.
[Before packets](evidence/packets-before.json) · [After packets](evidence/packets-after.json).

Both 35-second traces recover through the existing replacement-connection race,
with unchanged 4-second stall and 8-second race settings. That diagnostic happens
to favor the candidate (2.617 versus 2.885 seconds to usable input), illustrating
why it must not replace the repeated comparison's higher candidate median.
[Before application timeline](evidence/timeline-before.json) ·
[After application timeline](evidence/timeline-after.json).

At 64 kbit/s, steady dense lag stays close (1.525 → 1.537 seconds), while median
cap-removal catch-up rises from 0.125 to 0.206 seconds. Sparse loss/jitter output
also varies: 18.07 → 17.63 updates/s and 0.217 → 0.239 seconds p95 lag. Those
results are retained, not rounded into a claim of no recovery or loss penalty.
The [full tables](measurements.md) show all ranges, visible input counts and the
remaining 300 ms RTT limit.

## Bandwidth efficiency is workload dependent

At equal 20 Hz delivery, dense output favors Corgi, but healthy sparse output
uses substantially more total traffic than Herdr. See the [bandwidth comparison](bandwidth.md).
The throughput change allows more data in flight; it does not introduce a smaller
encoding for sparse updates.

Corgi's [row difference](../../../../src/pane/surface.ts) replaces each changed
row as a string and sends JSON metadata. Herdr's
[retained-surface producer](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/headless/retained_surface.rs#L45)
emits contiguous changed-cell spans. The follow-up capture confirms native
bincode `PaneSurfacePatch` messages; the optional base64-wrapped surface-delta
path cited in the initial analysis is not the path observed here.
Corgi also sends
a receipt RPC for each decoded frame, plus idle receipts. In a separate healthy
sparse trace it sends 663 receipt RPCs and 10 command RPCs during 30 seconds with
600 visible updates. The latter includes the harness's five input probes.
[RPC counts](evidence/receipt-traffic.json).

The follow-up [wire diagnosis](../wire-efficiency/report.md) supplies exact
application-byte attribution and a lossless compact-encoding experiment. It
also verifies the host's Huffman-only SSH compression, which does not remove
repeated strings. The original performance report measures complete link
traffic, including transport overhead; offline payload reductions must not be
read as measured wire savings. Herdr and Corgi's production encoding remain
unchanged by that investigation.
