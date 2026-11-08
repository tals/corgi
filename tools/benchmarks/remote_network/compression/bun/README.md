# Reproduce the Bun compression measurements

Read the [answer and comparison](report.md) or [all measured API paths](measurements.md).
This is a benchmark-only extension of the [native codec experiment](../README.md).
Corgi's application protocol and SSH packages are unchanged.

Use Bun **1.4.4** on Linux. The built-in modes require no additional package.
The optional `ffi-dict` mode loads the system `libzstd.so.1` (measured version
1.5.5). It is a native integration experiment, not a built-in Bun dictionary API.
No new dictionary is trained: every mode uses the previous experiment's frozen
8 KiB dictionary and held-out corpora.

```sh
python3 tools/benchmarks/remote_network/compression_bun_run.py \
  dist/zstd-final dist/zstd-bun-rerun --cpu 48 --repeats 3 --target-ms 150
```

Choose an available CPU. The runner holds the shared benchmark lock, pins the
process and its child threads to that CPU, shuffles the 40 matrix cells, and
runs each in three fresh Bun processes. It saves the actual benchmark source,
individual trials, medians/ranges and source hashes. The input directory can
instead point at `dist/zstd-final` extracted from the
[original raw archive](../../../../../dist/remote-zstd-20261108.tar.gz).

To run one cell:

```sh
taskset -c 48 bun tools/benchmarks/remote_network/compression_bun.ts \
  dist/zstd-final/sparse.corpus node-sync-dict \
  dist/zstd-final/agent-training-8192.dict 150
taskset -c 48 bun tools/benchmarks/remote_network/compression_bun.ts \
  dist/zstd-final/sparse.corpus deflate - 150
```

## What each mode does

| Mode | API and compression context |
| --- | --- |
| `bun-sync` | `Bun.zstdCompressSync`, level 3, no dictionary |
| `node-sync` | `node:zlib.zstdCompressSync`, level 3, no dictionary |
| `node-sync-dict` | Same one-shot API with the fixed dictionary |
| `frame` / `frame-dict` | Reusable public `createZstdCompress` stream; each write ends a complete independent zstd frame |
| `live` / `live-dict` | Reusable public zstd stream; each write flushes output but preserves history |
| `deflate` | Public `createDeflate`, level 6, windowBits 15, memLevel 8, default strategy, partial flush per message |
| `huffman` | Same Deflate API, level 1, Huffman-only strategy, partial flush per message |
| `ffi-dict` | Bun FFI calls system libzstd with reusable encoder/decoder contexts and compiled dictionaries |

Public stream modes set the `flush` option on construction and await each
`write` callback. This passes the message and flush directive together, rather
than scheduling another empty flush operation after each write. Zstd frame mode
uses `ZSTD_e_end`; history mode uses `ZSTD_e_flush`. A reusable JS stream therefore
does **not** necessarily imply compression history across messages. We do not
use private `_processChunk` methods.

Independent messages are decoded individually using fresh one-shot decoders
outside the timed loops, which proves they need no earlier compressed message.
For dictionary modes, decoding without the dictionary must fail. Continuous
zstd is also decoded from a fresh context at each recording boundary. Every
message must produce its complete plaintext before the next message is submitted.
Both initial and post-timing output are checked byte-for-byte.

There are five warmup passes, then at least 150 ms of process CPU for encoding
and separately for decoding. Timings include the JS API, returned-buffer
allocations, stream callbacks where applicable, and runtime/GC work. They exclude
JSON serialization, encryption, socket I/O and rendering. CPU uses
`process.cpuUsage`; wall timing is recorded separately. These are mean costs per
message within each trial, summarized by the median of three trials, not p95
message latencies. The original C experiment measured thread CPU and reused C
buffers, so its timings are not interchangeable with these Bun measurements.

Each timed pass starts with fresh logical compression history. Deflate resets
between recordings. Continuous zstd completes its frame at the recording
boundary, retaining its compiled dictionary and allocations. The final zstd
trailer is excluded from live payload totals but its API call is included in
the amortized timing. Independent-frame mode ends every message and needs no
extra boundary trailer. Both cold sizes and the observed range across all passes
are retained.

The FFI mode allocates/copies returned Buffers, so it includes the JS/native
boundary and owned-output costs. Its codec allocation sizes are measured directly
with libzstd's size APIs and exclude the Bun runtime, JS objects and output
buffers. Full-process memory snapshots include the benchmark's inputs, retained
outputs and GC state; they are **not** per-connection memory estimates. Built-in
codecs do not expose the same allocation counters, so we do not substitute
their process RSS for codec memory.

Bun's bundled codec revisions are in the raw trials. The old-SSH-style Bun
Deflate result uses the historical settings, but is not byte-identical to the
system-zlib control from the C experiment. The tables report actual Bun output
sizes rather than assuming equivalence. Compression ratios are original bytes
divided by compressed bytes; all values exclude SSH/TCP framing and receipts.

The raw archive linked from the report preserves the exact frozen corpora,
dictionary, measured source, trials and validation logs. Replaying these inputs
does not call any model or train on test traffic. Independent compression frames
still contain stateful Corgi row patches; codec independence does not remove the
application's sequencing requirements.
