# Production review follow-up

The implementation and original experiments were committed first (`a0156499`,
`34464036`, `47bb46fe`). Three independent reviewers then checked compression,
flow control, and daemon handoff. Their fixes are committed as **`b0e34828`**.

- Final decoded replies, frames, and reconnect notices survive TCP resets.
- A compressed reload requester receives the candidate's actual success/error;
  failed reloads retain resumable viewer links and reject pipelined input.
- Typing held for planned reconnect is bounded to 64 KiB, including input already
  queued when the notice arrives. Release does not spread a large argument list.
- Hello now offers `accept_encoding: ["zstd"]` and selects `content_encoding`.
  It has one round trip and a precise plaintext newline boundary, with no old
  remote-daemon compatibility aliases.

[Reviewed patch](evidence/review.patch) · [Validation](evidence/validation.json).

Validation passed **3,415 unit tests** and **72 distinct integration cases**
(two optional local-compatibility cases skipped). One integration failure exposed
a sandbox shutdown race: repeated signals exited its supervisor before children
finished writing checkpoints. Tooling fix `397e3316` passed a deterministic
regression and three full sandbox reruns. The initial failure remains in the
linked validation logs; no application binary changed for that fix.

The review also removed repeated RTT probes caused by serialization on a stable
slow link. **45 new isolated labs, three repetitions each**, compared the
previously accepted implementation with the reviewed build and stock Herdr + SSH-C.

| Scenario / metric | Before review | Reviewed Corgi | Herdr |
| --- | ---: | ---: | ---: |
| Dense, 600 ms / 64 kbit/s: P95 display age | 1.76 s | **1.00 s** | 30.81 s |
| Same case: visible updates/s | 2.87 | **3.13** | 1.17 |
| Dense 60 Hz, 300 ms / 1 Mbit/s: updates/s | 59.9 | **59.9** | 23.6 |
| 64 kbit/s → 1 Mbit/s: first fresh content | 0.13 s | **0.13 s** | None within 10 s |
| 3-second outage: usable after restore | 3.09 s | 3.12 s | **1.32 s** |
| 35-second outage: usable after restore | 3.00 s | **2.61 s** | 18.77 s |
| 3-minute freeze, no pending write: usable | 2.34 s | 2.35 s | 4.73 s |

Values are medians, not confidence intervals. The slow-link change improves P95
age by **43%** while delivering more updates; it does not solve the brief-outage
gap. The freeze stops client processes and kills server TCP state; it is not a
physical suspend test. Full ranges, CPU, bandwidth, and input evidence remain in
the [complete measurements](measurements.md). [Audit: 964 checks, zero problems](evidence/audit.json).

The subsequent [WebSocket evaluation](../../websocket_app/report.md) separately
tests standard WebSocket framing with the same codec and controller.

[Reproduce / test drive](README.md) · [Build identities](evidence/builds.json).
[Raw evidence archive](../../../../../dist/corgi-websocket-evidence-20261108.tar.gz).
