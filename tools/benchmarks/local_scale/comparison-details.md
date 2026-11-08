# Controls, checks, and limitations

| Agents | Mixed, idle tab visible: kB/s | Detached daemon CPU %: idle | Mixed | Spammy |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 2.48 → 2.60 | 1.93 → 1.73 | 3.83 → 3.73 | 5.30 → 5.37 |
| 8 | 2.48 → 2.54 | 2.33 → 2.17 | 5.40 → 5.53 | 8.73 → 8.56 |
| 32 | 2.44 → 2.56 | 4.13 → 4.30 | 13.70 → 12.93 | 20.80 → 20.04 |

**Repeated attempts:** 2 attempt(s) failed checks and were rerun unchanged. Earlier valid windows remain in the main table; later retries only fill failed or missing scenarios. [Attempt and continuation records](comparison-evidence/summary.json).

- `n32-p0-before`: Error: ProducerCadence: lane 2: 0. One baseline producer recorded zero writes in an active five-second sample; daemon stayed alive. Exclude the invalid workload attempt in full and retry unchanged, retaining full producer receipts for diagnosis.

- `n32-p0-after`: Error: ProducerCadence: lane 0: 289. All 32 producers stalled for roughly 0.6 seconds inside synchronous PTY writes during detached spammy, falling below the required source rate. Preserve the entire failed attempt, including its earlier 275.7 kB/s attached sample, and retry the full trial unchanged.

CPU windows: 15 s, without byte tracing. Separate bandwidth windows: 5 s. Warmup: 5 s. 68/132 windows exceeded the predeclared 2% SMT-sibling-load flag; all remain included. Small differences need more repetitions; two observations per build do not establish statistical significance.

Traffic differences include periodic metadata and measurement-boundary variation; the percentages do not isolate WebSocket framing overhead. Idle/quiet-tab samples are especially sensitive because their total traffic is small.

Synthetic agent output, minimal transcripts, one visible pane, no model calls. Provider CPU and terminal-emulator CPU are excluded. Startup/HTTP handshake costs are excluded. These measurements cover the local transport migration including its rollback support; they do not measure remote compression.

## First 32-agent spammy pair

Traffic: 224.00 → 275.70 kB/s. Producer volume: 1,372,160 → 1,372,160 bytes/s. Daemon socket writes: 216 → 262; viewer socket writes: 113 → 136, in 5 seconds. Average upstream bytes per write: 116.00 → 122.00. These are kernel write counts, not logical frame counts.

Decomposing the upstream difference by mean write size and write frequency gives 163.2 bytes/s from changed mean size and 533.6 bytes/s from changed frequency. This separates tiny per-write changes from additional output activity; it does not establish why activity changed. [Exact derivation inputs](comparison-evidence/outlier.json).

The first-valid-window rule is an explicit analysis amendment after the failures, recorded in `matrix/analysis-policy.json` in the raw archive. It prevents a later failure from removing an earlier unfavorable measurement. The original plan and continuation history are retained.

15 other valid retry windows are retained in [additional-trials.json.gz](comparison-evidence/additional-trials.json.gz). They do not replace earlier valid observations.

The 60-second follow-up uses the same unchanged builds and workload. It is one sample per build in before/after order, with separate 20-second untraced CPU windows. Its plan, full counters, and producer receipts are under `matrix/long-spammy/` in the archive.
