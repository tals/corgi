# What the compression experiment measures

## Inputs and separation

The network inputs are new 12-second sparse and dense captures from the real,
unchanged Corgi bridge: 246 `viewer.frame` messages each, including their row
strings, metadata and JSON envelopes. The sparse/dense producers use the
existing 20 Hz, 132 × 47 setup. The capture reducer's JSON reserialization is
checked byte-for-byte against the original syscall payloads before benchmarking.
Receipts, input traffic, SSH packet/channel fields, encryption, TCP/IP and
retransmissions are outside this codec comparison.

The agent inputs are replay-derived Corgi protocol messages. The existing
Claude and Codex fixtures contain real CLI screens while streaming a canned
TypeScript example and checklist from a local model stub. We feed those recorded
ANSI screens through the production terminal and `Frames` row-patch encoder,
acknowledge every frame, and verify reconstruction. This gives current protocol
bytes, including an initial full pane, but does not reproduce original PTY
chunking or live application scheduling. Session identities are deterministic
hashes of each recording, so independent recordings have different identifiers.

Both test agent recordings contain the same canned answer. Holding out only
one provider would leak that answer through the other provider. Consequently,
**neither test recording is used for training**. We recorded two additional
sessions with a different database-migration prompt and SQL response. One shared
dictionary is trained on those new Claude/Codex sessions plus the existing Micro
and shell recordings. Neither sparse nor dense network traffic is in training.

The split is by complete recording **and response content**, not alternating
frames or a chronological split within a recording. The runner records source,
scenario, corpus, dictionary and individual-message hashes; it rejects exact
training/test message overlap. Shared JSON keys, terminal conventions and common
CLI chrome are intentional reusable structure. We did not select dictionary
sizes or compression levels by optimizing a held-out score: both 8/32 KiB sizes
and levels 1/3/6/9/15/19 are reported. Training messages are shuffled with a
fixed seed before the library's trainer runs, so its internal validation split
does not consist entirely of the final workload. No held-out messages enter
that internal split. The 32 KiB capacity produced a 16,249-byte dictionary;
capacity is an upper bound, not the resulting size. The smaller dictionary is
exactly 8,192 bytes.

This remains a small synthetic-content corpus: two short agent interactions,
an editor, a shell and two generated network workloads. It demonstrates the
mechanism and costs on these inputs, not a production distribution of long
agent sessions, tools, images, random data, languages or screen dimensions.

## Identical boundaries and CPU measurement

Every codec receives identical unmodified message bytes in the original order.
Each message must be decodable before the next message is submitted. There is
no batching or whole-file compression that can conceal interactive latency.

| Mode | Context and message boundary |
| --- | --- |
| Installed SSH codec | zlib level 1, `Z_HUFFMAN_ONLY`, continuous context, `Z_PARTIAL_FLUSH` per message |
| Historical SSH codec | zlib level 6, default LZ77 strategy, same flush/context; offline diagnostic |
| Independent zstd | One complete zstd frame per message; reusable allocated contexts and optional compiled static dictionary |
| Streaming zstd | Continuous zstd history; `ZSTD_e_flush` after each message; optional initial dictionary |

The SSH rows reproduce the installed compressor settings, **not full SSH packet
processing**. Real SSH flush boundaries and channel headers can differ from the
application-message boundaries controlled here. The
[installed-version evidence](../wire-efficiency/evidence/openssh.json) and
[upstream change](https://github.com/openssh/openssh-portable/commit/1d5340fce24526719e32aebc4c721fc228182ace)
explain why this build's SSH compressor does not find repeated strings. Older
dictionary-enabled SSH is shown separately to avoid attributing that difference
to zstd alone. No SSH package was changed or downgraded.

The C harness reuses buffers and codec allocations, pins one CPU, measures
`CLOCK_THREAD_CPUTIME_ID`, and runs each encode/decode pass for at least 80 ms.
Each pass resets the session and traverses the complete corpus. Three fresh
processes per matrix cell run in a fixed shuffled order; tables use median
average CPU per message. Raw min/max values are retained. These are codec CPU
costs, not wall-latency percentiles or Bun/FFI, serialization and network costs.

Context/dictionary setup and the first encoding call are measured separately.
Encoding contexts can defer allocation until the first call. The first message
is a full pane in the agent corpora and an already-established patch in the
network corpora, so first-call timings are not a connection-init benchmark.
Training CPU is an offline cost, not a per-connection cost.

Memory comes from `ZSTD_sizeof_CCtx/DCtx/CDict/DDict` after the warm passes, and
tracked zlib allocations. zstd can shrink retained workspaces during repeated
use, so the summary reports the maximum observed retained allocation across
the three trials and preserves the range. It is **codec allocation**, not peak
process RSS. Input/output buffers, the application runtime and allocator
overhead are excluded. Compiled dictionaries can be shared by connections;
their allocation is reported separately from each connection's context.
[Pinned zstd API contracts](https://raw.githubusercontent.com/facebook/zstd/v1.5.5/lib/zstd.h).

All reported payload sizes include codec headers, dictionary IDs and flush
bytes. Dictionaries are assumed preinstalled at both ends; an on-demand
dictionary transfer would add its size. The streaming corpus ends after a live
flush, without an end-of-stream trailer. A separate size-only check applies the
installed SSH compressor to already-compressed zstd chunks, using the same
message boundaries, to assess stacking.

## Interpretation for Corgi

Independent frames with a static dictionary can compress repeated metadata,
padding, ANSI and row contents without retaining earlier messages as decoder
history. They still need application framing, dictionary/version negotiation,
fallback and decompression bounds. `ssh -C` does not provide zstd; this would be
an application-protocol implementation.

Continuous zstd can exploit the almost unchanged screen across messages, and
can beat independent frames substantially. It adds history/memory management
across reconnects and places trust boundaries around what may share that
history. The upstream SSH restriction specifically addressed adaptive
cross-channel dictionary leakage. Static independent frames remove that
cross-message history; that is not a claim that all compression side channels
disappear within a message.

Smaller messages should reduce bandwidth pressure, but this offline experiment
does not establish a change in displayed throughput, recovery time, connection
init or queue behavior. Those require implementing a codec and rerunning the
[network matrix](../throughput/README.md). Compression also does not remove
unnecessary message generation, serialization, acknowledgements or unchanged
metadata. Protocol optimization and compression address overlapping bytes but
different work.
