# PTY actor component experiment

Measured 2026-10-26 against frozen V14. Moving PTY read/feed into a native worker
did not reduce total consumer CPU by itself. Suppressing hidden-pane notifications
did help when the producer updates arrived at different times. These are component
results, not whole-application savings or a production-ready threading design.

## CPU results

Percentages are one-core CPU percentages: 100% means one fully occupied core.
Consumer CPU is the process total minus the separately measured producer thread;
it includes the native actor, Bun main thread, readiness thread, JIT and GC work.
Each cell is the mean of two fresh-process trials, with the observed range.

| Schedule | Existing Bun readiness | Native actor, all notifications | Native actor, visible notification only |
| --- | ---: | ---: | ---: |
| Aligned | 2.720% (2.708–2.733) | 2.720% (2.715–2.725) | 2.691% (2.680–2.702) |
| Staggered | 5.017% (4.887–5.147) | 5.321% (5.177–5.465) | 3.476% (3.393–3.559) |

Aligned native ownership is flat, and hidden coalescing saves only 1.1%. Staggered
ownership with all notifications regresses 6.1%; hidden coalescing saves 30.7%, or
1.541 CPU percentage points. Including the producer, staggered totals are
5.876%, 6.040% and 4.289%, so the coalesced case still saves 27.0%. This matters
because producer CPU varied between variants despite identical output/cadence.

The actor reduces main-thread work without necessarily reducing total work:

| Schedule | Main: existing / all / visible | Actor worker: all / visible |
| --- | ---: | ---: |
| Aligned | 2.274 / 1.988 / 1.975% | 0.414 / 0.403% |
| Staggered | 3.577 / 3.262 / 1.944% | 1.571 / 1.237% |

Do not count main-thread reduction alone as a performance win. Two repetitions
per mode establish a component signal, not a precise population estimate.

## What changes the work

All variants use sixteen real raw PTYs, identical 256-byte records at 20 Hz per
lane, one visible pane, 20 Hz maintenance for every lane, 4 Hz title/live-text
observations for every lane, and 20 Hz visible surface captures. Native feeding
continues immediately in the actor; hidden dirty bits are delivered to Bun during
its existing 50 ms maintenance pass. User input and terminal replies use the same
ordered pending-write queue, with WRITE readiness under backpressure.

The notification records and Bun socket chunks show the mechanism:

| Schedule / path | Notification records/s | Bun socket chunks/s |
| --- | ---: | ---: |
| Aligned, existing | 320 | 20.02 |
| Aligned, actor all | 320 | 20.72 |
| Aligned, actor visible | 20 | 20.00 |
| Staggered, existing | 320 | 320.01 |
| Staggered, actor all | 320 | 320.01 |
| Staggered, actor visible | 20 | 20.00 |

The aligned existing path already batches its socket wakeups. Removing fifteen
records from each batch therefore buys little. The staggered path wakes Bun for
each lane; coalescing reduces delivered wakeups by 93.75%. This comparison keeps
the native ownership path fixed between actor-all and actor-visible.

All cases retain about 320 lane-maintenance calls/s, 64.43 observations/s and
20.00 visible captures/s. The slight observation excess is the inclusive sample
boundary. The actor still services about 320 readiness events/s, makes about
640 PTY reads/s including EAGAIN, and rearms about 320 registrations/s. Its
one-shot rearm policy intentionally matches the existing ownership comparison.

Phasing alone changes the existing path from 2.720% to 5.017% on identical bytes
and per-lane rates. Whole-app comparisons therefore need controlled producer
phase, not just matched average throughput. Aligned writes wait once per tick,
then write lanes sequentially; they are not literally simultaneous.

## Validation and measurement controls

The reviewed C helper compiled with `-O3 -std=c11 -Wall -Wextra -Werror` and the
focused TypeScript check passed. Both before and after adding producer timestamp
recording, six short correctness cases covered all variants and schedules:
96 final terminal surfaces, 126 exact feed-prefix captures, and ordered duplex
output in all 96 lane cases. Revision equality is deliberately excluded because
read chunking differs. Coverage includes fragmented escape sequences, wide and
combining glyphs, styles, links, titles, clipboard, modes, scrolling and replies.
Actor cases also recover 4,096 queued notifications from a three-byte partial
record with socket EAGAIN, force positive input backpressure, synchronously
pause/join, read the original FD for handoff, then restart after simulated rollback.

Timing uses a prospective ten-second placement pilot, then CPUs 8–15 on NUMA node
0 and their SMT siblings 136–143, all in one L3 group. The CPU0 observer holds the
global benchmark lock; only owned descendants receive min=max1024 clamps. Each
scenario runs ready→all→visible→visible→all→ready, with ten seconds warmup and
thirty seconds measured. Three attempts per position were allowed prospectively;
all twelve passed on their first attempt, with every process cleaned up.

- Worst whole-run sibling activity: 0.734%; measured-window worst: 0.623%, both
  below the predeclared strict 2% limit. All 480 clamp snapshots passed.
- All expected bytes and timed producer events arrived. Maximum write lateness
  was 1.375 ms; minimum same-lane gap 48.757 ms; cadence 19.99985–20.00044 Hz.
  Predeclared limits were 25 ms lateness, 25 ms minimum gap and 19.6–20.4 Hz.
- Aligned p95 first-to-last-lane write spread was 55–60 µs. Staggered p95 phase
  error was 90–146 µs. Exact intended deadlines and actual start/end timestamps
  are retained; these extra summaries were not post-hoc rejection filters.
- Both paths retain their benchmark counters. Producer timestamp recording is
  identical in all variants and is included in its separately reported CPU.
  This is not a counter-free timing claim.

## Provenance and limits

Raw attempts, fixed plan, producer timestamps, host samples, per-thread user/system
endpoints, source copies and failures are under `dist/pty-actor-timing-v14/`.
`analysis.json` contains the aggregate rates; `plan.json` records the frozen
observer and workload hashes. Earlier correctness logs are in
`dist/pty-actor-preflight-v14/`. Initial harness type failures are preserved.

- Frozen product source: `599711dca842026e815c47f6219280ec98e2163af90f2702cf7fca2e90563a93`
- Four native assets: `f47eecce50af1f1f0130dbf484165706639f8c04cc74532859555b00acf48cac`
- Timing helper DSO: `ee89ad014d5973dfe3a32c7b02e0d736d41f6a1a2f5054faf9045ff7d3088d35`
- Timing TypeScript: `2f7e88f00e131764a72dc9504b66333e6a0e87ae5c3dc8410a97cb4df380d23c`

All VT access and borrowed-title copies use per-handle locks. Handles are created
before the actor starts; this does not prove safety for production's dynamic
creation, image/global decoder state, synchronized-output expiry or every removal
and handoff path. There is no flood-fairness or lock-wait histogram yet. The
prototype's notifications are per readiness service, whereas the baseline can
emit per feed chunk. The benchmark has no production subscriber work attached.

The next bounded experiment compares actor-visible's existing one-shot policy
with its already implemented level-triggered mode. It should isolate worker
rearm operations while holding ownership and notification policy fixed. That
path has not yet been executed; its correctness preflight must precede timing.
