# Local daemon: bandwidth and CPU at 4, 8, and 32 agents

Production Corgi at `a49dd498`, uncompressed WS over Unix sockets. One viewer, one visible pane; other agents remain running in background tabs.

**Reliability finding:** the daemon exited unexpectedly during one original 32-agent trial. The cause is unresolved; its initial cleanup removed the daemon log. A full rerun passed with log retention enabled. The aborted attempt is archived under `matrix/failures/` and excluded from the table; [the summary](evidence/summary.json) records the replacement and continuation.

Three-trial medians. CPU is **percent of one core** (100% = one fully occupied logical core), including every thread. Traffic is **kB/s, both directions combined**, including WS framing. Provider/inference CPU is excluded.

| Agents | Mix | Daemon CPU | Viewer CPU | Viewer↔daemon | Daemon CPU, detached |
| ---: | --- | ---: | ---: | ---: | ---: |
| 4 | Idle† | 2.60% | 4.40% | 2.86 | 1.90%† |
| 4 | Mixed | 7.65% | 12.40% | 224.11 | 4.20% |
| 4 | Spammy | 9.20% | 12.40% | 224.12 | 6.05% |
| 8 | Idle | 3.15% | 4.80% | 2.81 | 2.25%† |
| 8 | Mixed | 9.20% | 14.30% | 224.09 | 5.60%† |
| 8 | Spammy | 13.40% | 13.20% | 224.09 | 9.35%† |
| 32 | Idle† | 5.05% | 6.05% | 2.30 | 4.45%† |
| 32 | Mixed† | 17.80% | 14.30% | 224.09 | 14.74% |
| 32 | Spammy | 26.20% | 16.90% | 226.35 | 22.05% |

**Mixed = half idle, one quarter light, one quarter spammy.** Light is one row at 2 Hz. Spammy is 16 colored lines per burst at 20 Hz (320 lines/s, 42.88 kB/s per agent). The mixed rows above focus a spammy tab. All-idle agents emit zero terminal output; Corgi's normal animation/resource work stays enabled.

**Hidden output is much cheaper on the wire.** With the same mixed agents running but an idle foreground tab, traffic is **2.99 kB/s at 4 agents**, **3.03 kB/s at 8 agents**, **2.53 kB/s at 32 agents**. Detached viewers send/receive zero bytes; internal worker notifications are counted separately.

[Trial medians, ranges, direction splits and CPU controls](evidence/summary.json) · [All measured windows](evidence/trials.json.gz) · [Raw kernel/producer/presentation evidence](evidence/raw.tar.gz) · [Reproduction playbook](playbook.md)

† 11/66 windows crossed the host-noise flag; all completed windows remain included. [Ranges, tracing controls and accounting limits](details.md).

Without tracing, the 32-spammy-agent CPU medians were **25.70% daemon + 15.45% viewer**. The table consistently uses traced windows.

These are synthetic terminal workloads with minimal provider transcripts. Growing conversation histories, real model/provider integration work, multiple visible panes and terminal-emulator CPU are outside this measurement. [Exact workload and playbook](playbook.md).

[Independent receipt audit](evidence/audit.json) checks the kernel totals, producer output and visible progress.
