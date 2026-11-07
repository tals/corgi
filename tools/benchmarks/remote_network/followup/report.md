# Remote networking: gaps closed and remaining

[Latest: rebased branch and long-outage recovery fixes](../outages/report.md).

**The cached-workspace crash is fixed, and constrained links now stay usable.**
Corgi displayed **120/120** bandwidth/loss input probes; independent remote
logs confirm **120/120** executions, with no duplicate tokens.
[Receipts and trial data](evidence/summary.json).

| Measurement | Corgi before | Corgi fixed | Herdr |
| --- | ---: | ---: | ---: |
| 256 kbit/s progress screen: p95 age | 29.91 s | 0.12 s | 0.10 s |
| 64 kbit/s progress screen: p95 age | 32.22 s | 0.57 s | 7.25 s |
| 256 kbit/s dense output: p95 age | 29.95 s | 0.36 s | 20.28 s |
| 1% loss + jitter: p95 screen age | 6.86 s | 0.21 s | 0.10 s |
| Lift 64 kbit/s cap → fresh screen | 2.13 s | 0.15 s | 0.16 s |
| 3-second outage → usable input | 4.25 s | 2.49 s | 0.79 s |
| 15-second outage → usable input | 2.51 s | 3.41 s | 13.03 s |

Values are medians of three trials at 120 ms RTT; lower is better. Screen age
includes time spent showing a frozen frame. The Herdr column is the original
unmodified v0.9.5 reference, not the additional one-round control.
Real SSH and viewers connect a client and two remotes, with four panes per
machine; stream windows last 30 seconds at a nominal 20 Hz.
Numbers pin `691fc36b`; the later pane-exit fix (`59a7fa4c`) has separate
[regression validation](evidence/validation.json).
[Before/Herdr evidence](../measurements.md) · [Fixed Corgi and new control](measurements.md).

**Startup:** the previously failing cold attach at 300 ms RTT now succeeds
**3/3** times. At 120 ms, cold/warm
attach to usable input takes **3.09/1.67 s**.
[All attach attempts](measurements.md#connection-init).

**Client freezes:** recovery to usable input took **2.60/2.96 s**
after 3/11 minutes. Both retained all eight remote workloads and executed the
pending input once. These are single trials using SIGSTOP plus lost TCP
connections; they do not measure physical laptop suspend.
[Continuity evidence](measurements.md#real-elapsed-time-client-freezes).

**Remaining gaps:** short-outage recovery still trails Herdr. The measured 15-second-outage median is also higher than before. Dense output at
1 Mbit/s delivers **14.0 updates/s**, versus Herdr's 20. Sparse unrestricted
traffic is **202 kbit/s**, versus **74 kbit/s**. The conservative
queue bound favors freshness over maximum throughput.
[Frame rates, traffic and ranges](measurements.md#bandwidth-and-screen-freshness).

The fixes send changed rows, acknowledge decoded frames, bound outstanding
render data, and enable SSH compression. Cached selections wait for the live
workspace; instant typing can seed from an idle screen when agent identity
arrives later. Older peers retain full-frame compatibility; Herdr is unpatched.
[Transport](../../../../src/viewer_stream.ts) · [Protocol notes](../../../../HACKING.md#change-protocols-or-saved-formats).

[Validation](evidence/validation.json) · [Evidence audit](evidence/audit.json) ·
[Reproduction playbook](README.md) · [Raw archive](../../../../dist/remote-network-followup-final.tar.gz)
