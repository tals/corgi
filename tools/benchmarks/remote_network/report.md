# Corgi remote networking vs Herdr

**Corgi connects faster and recovers faster from long outages in this fixture.
Herdr keeps the screen much fresher on constrained links.** Corgi's next
priorities should be the startup crash and accumulated stale output.

Tested November 6, 2026: Corgi's `design/remote-attempt-2` at
[`eeef7b27`](https://github.com/tals/corgi/commit/eeef7b27d46316dec1fc216541337c5c1785f67e)
against the unmodified official [Herdr v0.9.5](https://github.com/herdrdev/herdr/releases/tag/v0.9.5).
Neither application was patched. [Binary pins and provenance](evidence/provenance.json).

**Startup failure:** selecting a cached remote workspace while reconnecting at
300 ms RTT crashed Corgi with `NoWorkspace` in **3/3 attempts**. Herdr completed
the same three attempts. These failures are retained separately from successful
latencies. [Crash recordings](evidence/startup-crash.txt), [startup results](measurements.md#connection-init).

| Measurement | Corgi | Herdr |
| --- | ---: | ---: |
| [Attach → acknowledged input, cold / warm SSH](measurements.md#connection-init) | 3.11 / 1.67 s | 4.33 / 2.78 s |
| [~3-second outage → acknowledged input after restoration](measurements.md#recovery-after-network-restoration) | 4.25 s | 0.79 s |
| [~15-second outage → acknowledged input after restoration](measurements.md#recovery-after-network-restoration) | 2.51 s | 13.03 s |
| [256 kbit/s: displayed screen age, p95](measurements.md#bandwidth-and-screen-freshness) | 29.91 s | 0.10 s |
| [256 kbit/s: visible input acknowledgements within the window](measurements.md#input-under-bandwidth-pressure) | 0/15 | 15/15 |
| [Lift 64 kbit/s cap → fresh screen, median and range](measurements.md#bandwidth-and-screen-freshness) | 2.13 s [2.10–10.74] | 0.16 s [0.14–0.17] |
| [3-minute client freeze → acknowledged input after wake](measurements.md#real-elapsed-time-client-freezes) | 2.73 s | 5.26 s |
| [11-minute client freeze → acknowledged input after wake](measurements.md#real-elapsed-time-client-freezes) | 3.23 s | 15.10 s |

Both products kept the local workspace and unaffected remote usable during a
single-machine outage. Remote workloads survived both freeze durations. No
duplicate test inputs were observed, but early-outage inputs sometimes executed
much later; a missing visible reply does not establish non-execution.
[Isolation and input receipts](measurements.md#healthy-machines-during-atlas-isolation).

**Compression helps, but is insufficient here.** Herdr enables SSH compression
by default. Enabling it for Corgi improved the 256 kbit/s sparse trial from
about 30 s to 20 s p95 screen age, with only 2/5 visible input acknowledgements.
That diagnostic has one trial per profile. Investigate smaller updates and
control of queued render history alongside compression.
[Diagnostic measurements](measurements.md#bandwidth-and-screen-freshness),
[source-based explanation](interpretation.md).

The table uses 120 ms RTT and median results from three independent trials;
each freeze duration has one trial per product. Bandwidth rows use a 20 Hz
progress screen over 30-second windows; p95 describes time within each trial.
Real SSH and real viewers run across an isolated Linux network fabric, with
two remotes and four panes per machine, including the client. **Client freezes
use SIGSTOP and lost connections, not hardware suspend; kernel TCP timers keep
running.** These wake timings do not predict physical laptop wake latency.

[Full measurements, dense-output stress, loss/jitter, and raw-file index](measurements.md)
· [Reproduction playbook](README.md)
· [Raw evidence archive](../../../dist/remote-network-20261106/raw.tar.gz)
· [Evidence audit](evidence/audit.json)
