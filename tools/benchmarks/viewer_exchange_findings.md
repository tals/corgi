# Same-JSON viewer exchange result

The single predeclared ABBA found lower CPU with immediate push, but the viewer
portion is modest and production pacing was deliberately omitted from push.
No protocol or production transport changed.

| Endpoint | Wake + settle + pull | Immediate push | Difference |
| --- | ---: | ---: | ---: |
| Client | 1.220% core | 1.029% core | −0.191 points |
| Server, including readiness thread | 1.090% core | 0.785% core | −0.306 points |
| Combined endpoints | 2.311% core | 1.814% core | −0.497 points (−21.5%) |

One hundred percent is one logical CPU's full time. These are means of two
fresh-process samples per mode, not a confidence interval. In sequence, the
combined results were 2.231, 1.740, 1.887, 2.390% core for pull/push/push/pull.
Client ranges were 1.170–1.271 for pull and 0.983–1.075 for push; server ranges
were 1.061–1.119 and 0.758–0.812. The mean difference corresponds to about
24.9 μs of combined process CPU per offered update at 20 Hz.

Each trial warmed for three seconds and measured ten seconds. Both modes used
the same production `peer.Client` / `ReadyLoop` server path, two sockets, Node
UTF-8 client framing, bigint-aware JSON and canonical row receipts. The saved
132×47 corpus came from real `Terminal.surface` output, with a constructed hot
View envelope omitting unchanged session/resources. Capture and composition
were outside timing. Both clients had a 16 ms no-op heartbeat; this is a
scheduling control, not the full viewer loop.

## Work and correctness

Every measured trial delivered exactly 200 offered revisions, performed 9,400
row comparisons with 410 changed rows, received 1,833,394 main-channel bytes,
and had 200 main-channel data callbacks. Thus the comparison did not obtain its
saving by dropping views or reducing receipt work.

| Additional work per ten-second sample | Pull | Push |
| --- | ---: | ---: |
| Wake socket callbacks | 200 | 0 |
| Wake socket bytes | 4,600 | 0 |
| Settle timer callbacks | 200 | 0 |
| Sync requests and server request dispatches | 200 | 0 |
| Heartbeat callbacks | 621 / 621 | 621 / 620 |

These callback counts are exact harness observations, not exact runtime wake
counts. Client voluntary context switches were 2,272/2,283 for pull and
1,797/2,270 for push; server values were 1,639/1,875 and 1,721/1,640. Their
variation cautions against equating one callback with one scheduler wake.

The six runtime preflight cases passed on their first execution: ordered 20 Hz
delivery, paused-reader backpressure, and disconnect rejection of an outstanding
request for both modes. Push backpressure left 614,082 bytes in the production
output queue and later delivered all 96 burst revisions. Pull coalesced the burst
to revision 96, as intended. Those unequal burst workloads were correctness
checks only. Pure framing checks also covered one-byte and seven-byte splits,
UTF-8 boundaries, coalesced lines and a u64 beyond JavaScript's safe integer range.

## Limits of the result

Immediate push removes the existing 2 ms settle timer instead of relocating it.
Production must retain the 2 ms settle, 8 ms minimum, 33 ms flood and typing/idle
prompt behavior. Therefore this result is optimistic component evidence, not a
whole-app speedup or a rigorous maximum saving. A meaningful next experiment,
if pursued, is daemon-paced push with equivalent coalescing before considering
protocol work. The measured client difference alone cannot explain the roughly
1.6-point controlled viewer gap against Herdr.

Median receipt latency was 3 ms for pull and 0 ms for push; p95 was 3 versus
1 ms. `Date.now()` has 1 ms resolution here, and push skipped settling, so these
are not equivalent-policy latency claims. Maximum producer timer lateness was
1–2 ms. No output or revision was missing in any measured window.

## Placement and provenance

The benchmark ran serially on CPUs 40–47, memory bound to NUMA node 0. The
observer ran outside those CPUs and their SMT siblings. All 40 clamp snapshots
inside measurement windows showed requested/effective min/max 1024/1024 for
the benchmark descendants. Whole-invocation maximum sibling load was 1.894%,
which narrowly passed the predeclared 2% guard. No extra timing variants or
selective retries were run. This is one accepted placement, not replication
across NUMA nodes.

The product dependencies were restored V15. An unrelated viewer-loop candidate
was present, but `viewer.ts` is not imported by this fixture. All explicitly
recorded dependency, harness and native-library hashes matched before and after
timing. The ordinary runtime extraction and current shared libraries were used;
the benchmark did not substitute a new native implementation.

`dist/viewer-exchange-v15/` preserves:

- `preflight/trials.jsonl` and `preflight.log`: all six runtime checks.
- `plain.json`: exact canonical corpus, native hash and per-view byte sizes.
- `timed/plan.json`: prospective order, duration, placement and noise policy.
- `timed/manifest.json`, `timed/sources/`: exact source/native/fixture hashes and
  source copies, including Bun revision and affinity.
- `timed/trials.jsonl`, `timed/run.log`: per-role raw user/system CPU, bytes,
  callback counts, context switches and latency.
- `timed/host.json`, `timed/summary.json`: host/clamp observations, acceptance
  and post-run input-hash checks.

Focused TypeScript checking and formatting passed. Two earlier compiler
invocations are retained: the first omitted the project's ambient declarations;
the second named the wrong declaration file. Adding the existing
`src/assets.d.ts` to the focused invocation passed without a code correction.
