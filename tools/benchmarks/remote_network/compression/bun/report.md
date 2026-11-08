# Zstd history, Bun costs, and old SSH behavior

**The independent-message candidate keeps the trained dictionary fixed and
discards compression history between messages.** It can still match repetitions
inside the current message. The separate continuous-stream candidate adds live
history alongside the same fixed dictionary. These are experiments; Corgi's
production protocol is unchanged.

**Dictionary compression is built into Bun 1.4.4 through `node:zlib`.** Its
`zstdCompressSync` and `createZstdCompress` APIs accept a dictionary. The simpler
`Bun.zstdCompressSync` exposes only the level. We verified dictionary use by
requiring decoding without it to fail.
[Bun dictionary API](https://bun.com/reference/node/zlib/ZstdOptions),
[simple API](https://bun.com/reference/bun/zstdCompressSync).

Actual Bun costs, level 3 + the frozen 8 KiB dictionary; ranges span the four
held-out workloads, not latency percentiles:

| Independent-message implementation | Encode CPU/message | Decode CPU/message | Integration |
| --- | ---: | ---: | --- |
| Built-in one-shot API | 28–52 µs | 15–18 µs | No additional package |
| Reusable built-in stream, ending each message | 20–48 µs | 20–28 µs | No additional package |
| Bun FFI with reusable native contexts/dictionaries | 3.5–26 µs | 1.4–5.5 µs | Needs native codec integration |

At 20 messages/second, 50 µs of encoding is **1 ms of CPU per second**, about
0.1% of one core. This is modest codec work on the measured EPYC CPU; it excludes
serialization, network and rendering. The FFI experiment retained **270–474 KiB
of encoder state including a compiled dictionary, and 129 KiB decoder state**,
plus scratch/output buffers and Bun overhead. Compiled dictionaries can be
shared. Exact built-in codec allocations are not exposed by these APIs.
[All API paths, raw timings and memory](measurements.md).

**We can reproduce the old SSH algorithm using Bun's built-in Deflate stream.**
It is standard zlib/DEFLATE: level 6, a 32 KiB sliding history window, normal
string matching, and a partial flush after each message. It learns recent
traffic automatically and requires no pre-trained dictionary.
[zlib documentation](https://zlib.net/manual.html).

Actual Bun **compressed bytes/message**, with original/compressed ratio in the
Deflate column. All zstd rows use level 3 and the same 8 KiB dictionary:

| Held-out workload | Independent zstd | Old-SSH-style Deflate | Live-history zstd |
| --- | ---: | ---: | ---: |
| Sparse | 286 | **73 (22.0:1)** | 58 |
| Dense | 1,903 | **1,709 (3.2:1)** | 1,737 |
| Claude | 263 | **113 (17.8:1)** | 92 |
| Codex | 314 | **111 (25.3:1)** | 82 |

The built-in Deflate stream encoded in **23–71 µs/message**. The built-in live
zstd stream with the dictionary took **18–55 µs/message**. Live zstd wins on the
three sparse/agent cases; Deflate is slightly smaller on dense traffic. For
dense traffic, live zstd **without** a dictionary was smaller still: 1,671 bytes
per message. A dictionary is not always an improvement.

Keeping live history is the large additional bandwidth saving on repetitive
traffic. It also introduces decoder history across messages and revives the
trust-boundary question behind SSH's change; replacing the codec does not
resolve that issue. No application compressor or SSH configuration was changed.
[Previous security context](../method.md#interpretation-for-corgi).

These are payload/API measurements, excluding SSH/TCP framing and receipts.
All **120 fresh-process trials** decoded byte-for-byte. Independent frames were
also decoded with fresh decoders to verify their lack of prior-message
dependencies. Training and holdouts are unchanged from the previous experiment.
[Validation](evidence/validation.json), [reproduction playbook](README.md),
[raw archive](../../../../../dist/remote-zstd-bun-20261108.tar.gz),
[artifact hashes](evidence/artifacts.json).
