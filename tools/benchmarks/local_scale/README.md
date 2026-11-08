# Local transport: before and after WebSockets

Before: `6c9cafb3` (raw streams). After: `a49dd498` (uncompressed WebSockets over Unix sockets). Production builds use identical Bun and native code.

2 samples per build and agent count, reversing build order. Entries are **before → after** means, using the first valid window per scenario. CPU is percent of one core; traffic is actual socket **kB/s, both directions**, including framing. One visible pane.

| Agents | Workload | Daemon CPU % | Viewer CPU % | Traffic kB/s |
| ---: | --- | ---: | ---: | ---: |
| 4 | Idle | 2.73 → 3.00 | 4.67 → 5.73 | 2.34 → 2.45 |
| 4 | Mixed | 7.37 → 7.57 | 12.43 → 12.57 | 223.81 → 221.86 |
| 4 | Spammy | 7.30 → 7.63 | 11.17 → 11.33 | 223.87 → 224.01 |
| 8 | Idle | 3.27 → 3.50 | 6.23 → 5.90 | 2.30 → 2.29 |
| 8 | Mixed | 9.37 → 9.43 | 13.97 → 13.90 | 223.83 → 224.07 |
| 8 | Spammy | 12.13 → 12.37 | 12.57 → 12.90 | 224.35 → 224.12 |
| 32 | Idle | 4.93 → 4.93 | 6.27 → 6.07 | 2.18 → 2.08 |
| 32 | Mixed | 16.53 → 16.87 | 14.63 → 14.80 | 224.95 → 224.02 |
| 32 | Spammy | 24.10 → 24.27 | 15.00 → 15.87 | 223.88 → 249.85 |

**32-agent spammy traffic is variable:** the two primary WebSocket samples were 223.99 and 275.70 kB/s. The higher sample remains in the mean; the longer follow-up below checks whether it persists.

Mixed = 50% idle, 25% light (one row at 2 Hz), 25% spammy (16 colored lines at 20 Hz); a spammy tab is visible. Spammy = every agent produces 42.88 kB/s. Idle retains normal Corgi animation/resource work.

[Paired differences, ranges and direction splits](comparison-evidence/summary.json) · [Raw receipts and exact harness](comparison-evidence/raw.tar.gz) · [Independent audit](comparison-evidence/audit.json) · [Reproduction](comparison-playbook.md)

CPU was measured without tracing; bandwidth used separate kernel-counter windows. 68/132 windows crossed the host-noise flag; all valid windows are retained, with extra retries reported separately. Small differences remain uncertain on this shared host.

2 attempts failed validity checks and required repeats. Earlier valid windows remain in the table; the failure records are retained. [Diagnostics](comparison-details.md).

A detached attempt recorded overlapping PTY-write stalls across 32 producers: 0.59–0.63 s. The cause remains unresolved.

**Long 32-agent spammy check (60 s): 238.65 → 234.04 kB/s.** This follow-up is separate from the short-window means above; the original observations are retained.

[Detached/quiet-tab controls and limitations](comparison-details.md) · [Earlier current-only results and unresolved daemon exit](CURRENT_ONLY.md)
