# Actual TCP and WebSocket transport comparison

Run from the repository root, with Bun 1.4.4 and Linux `taskset`:

```sh
taskset -c 178 bun tools/benchmarks/remote_network/websocket_eval/run.ts \
  --cores 176,177,178 --trials 7 --cases latency,throughput \
  --output tools/benchmarks/remote_network/websocket_eval/evidence/loopback

taskset -c 178 bun tools/benchmarks/remote_network/websocket_eval/run.ts \
  --cores 176,177,178 --trials 3 --cases 300ms-1mbit,freeze,reconnect \
  --output tools/benchmarks/remote_network/websocket_eval/evidence/shaped

python3 tools/benchmarks/remote_network/websocket_eval/summarize.py \
  tools/benchmarks/remote_network/websocket_eval/evidence/loopback \
  tools/benchmarks/remote_network/websocket_eval/evidence/shaped \
  --output tools/benchmarks/remote_network/websocket_eval/evidence/summary.json

python3 tools/benchmarks/remote_network/websocket_eval/audit.py
```

Choose three physical cores with idle SMT siblings on another host: first server, second client,
third the outer `taskset` running the proxy. `--cores` selects endpoint CPUs;
its third value records the intended proxy core, which the outer command pins.
For a quick smoke run add `--quick --trials 1`; this truncates each corpus to
32 messages, so do not compare its bytes or timing with full runs. The runner
processes cells sequentially in a fixed shuffled order. `--modes` and `--corpora`
accept comma-separated subsets. Raw trials include per-message delay samples.

## What is measured

Two separate Bun processes communicate through real loopback TCP connections.
Raw TCP uses Bun's `node:net` compatibility API; WebSocket uses Bun's native
`Bun.serve` and global `WebSocket`. A third process, the parent runner, forwards
and counts actual socket bytes. It is excluded from endpoint CPU measurements.
This is a transport/component benchmark, not Corgi UI rendering or SSH throughput.
The production server's native FD loop is not reproduced by the raw TCP server.

All variants send exactly the same newline-delimited bytes, in the same order,
and receive the same per-message acknowledgment shape. The client byte-compares
every decoded message with its fixture. Acknowledgments include a monotonic
receive timestamp from Linux `clock_gettime(CLOCK_MONOTONIC)` via Bun FFI,
allowing cross-process one-way delivery measurements on the same host without
adding benchmark fields to application messages. Bun’s process-relative hrtime
epoch is not used. The runner rejects negative one-way delays. An acknowledgment
means decoded and verified, not displayed. Timestamp values vary between trials.

| Mode | Compression and lifetime |
|---|---|
| `tcp` | Plain JSON lines over TCP |
| `websocket` | Same JSON lines in uncompressed binary messages |
| `tcp-zstd` | Exact production `src/wire_compression.ts` `Channel`, live level-3 zstd, 1 MiB window |
| `websocket-zstd` | Identical `Channel`; its compressed chunks become binary messages; native WS compression disabled |
| `websocket-deflate` | Bun native `permessage-deflate`, dedicated compressor/decompressor per connection, server `send(bytes, true)` |

`websocket-zstd` is application compression carried in WebSocket binary messages;
it is **not a negotiated zstd WebSocket extension**. The installed Bun supports
native permessage-deflate, not a native zstd extension. The related
[capability evidence](../websocket_app/capabilities.md) records this distinction.
The byte inspector checks the actual upgrade request/response, RSV1 bits and
client masks. Deflate must negotiate without `no_context_takeover` and every
server data frame must actually be compressed. Small native-client acknowledgments
remain uncompressed under Bun's threshold; zstd compresses both directions. This
is the behavior of those stacks, so it is not a pure algorithm-only comparison.
No mode trains or loads a dictionary. Every connection begins with empty history.

The [fixture manifest](fixtures/manifest.json) preserves original source and
extracted corpus SHA-256 hashes. Sparse/dense are actual captured Corgi frame
payloads from the previous 20 Hz, 132×47 network experiment. Claude/Codex are
previously held-out real CLI recordings with canned model-stub content, replayed
through the production terminal and row-patch encoder. These are a small corpus,
not a representative distribution of all user activity. Extraction preserves
all application values and the prior compact JSON encoding. The bundled gzip
files are storage only; they are decompressed before testing. Fixtures retain
large integer JSON literals without converting them through JavaScript Number.

## Scenarios and accounting

- `latency`: one outstanding message; full trace; seven fresh connections per cell.
- `throughput`: up to 16 outstanding messages; full trace; seven fresh connections.
  Messages are offered as fast as acknowledgments allow. This is delivery capacity,
  not application FPS, and does not use Corgi's adaptive controller.
- `300ms-1mbit`: the first 96 sparse/dense messages, window 16; 300 ms RTT and
  125,000 bytes/s independently per direction; three fresh trials.
- `freeze`: full dense trace, window 16, 30 ms RTT; hold downstream bytes for
  one second, starting 100 ms after the first application-ready payload. Both
  clients continue running and upstream traffic remains live. This is **not a
  sleeping-client experiment** and retains queued frames rather than coalescing.
- `reconnect`: full dense trace, 30 ms RTT; deliberately terminate the transport
  after message 48 and open a new one, continuing from message 49 with fresh
  codec history. Already queued frames on the old transport can be discarded.
  Every final decoded application message is still verified. This tests transport
  reset/catch-up mechanics, not whether a real application can resume a row delta
  without a new rendering baseline.

The proxy is a deterministic **userland** delay/bandwidth/traffic-hold mechanism,
not kernel netem. It preserves a FIFO per direction, partitions capped traffic
into at most 256-byte segments, and delays delivery until serialization plus
propagation have elapsed. Timer granularity affects millisecond-scale details.
Freeze and bandwidth are separate cases: held traffic is released in order when
the hold ends. The application experiment in `websocket_app` is the authority
for actual netem recovery, coalescing, SSH, rendering and user-visible behavior.

CPU is combined server+client **post-open processing CPU**, divided by verified
messages. Process startup, fixture loading, initial socket/WS upgrade and initial
codec construction are excluded. Deferred first-use codec work is included.
The client clock stops only after the final ACK's own encode callback and asserts
that no codec input remains; server CPU stops upon receiving that final ACK.
CPU includes framing, validation, receipt JSON and runtime/library integration;
it does not isolate compression algorithm CPU. Raw/WS codec integration differs.

The retained 280 loopback trials were repeated after this task’s E2E matrix and
sandbox runs finished. Server/client/proxy used logical CPUs 176/177/178, whose
SMT siblings are 48/49/50. During the recorded one-second samples, those siblings
averaged 0.45%/0.45%/0% busy. Root evidence publication ran on CPU 0/1. This is a
shared host with uncontrolled background processes, not dedicated hardware.
The [CPU context](evidence/loopback/cpu-context.json) and
[samples](evidence/loopback/cpu-utilization.json) retain that distinction. The
36 shaped trials are the previously validated run; only loopback was repeated.

Connection latency begins immediately before the client's transport constructor.
Raw connect time ends at the local proxy acceptance; the proxy does not shape
TCP SYN/setup packets. Use first-content latency for the comparable startup
measurement, which ends at the first complete verified payload. WS includes
its real HTTP upgrade round trip. Both protocols then exchange a benchmark-ready
message; there is no extra production Corgi hello in this component harness.
Reconnect-to-content timing includes fresh connection setup and codec history.

`raw_bytes` counts original decoded application payload. `down_payload_bytes`
counts the compressed/raw transport payload (excluding WS framing).
`data_bytes` counts both directions after the upgrade, including WS headers and
client masks. `socket_bytes` also includes the HTTP upgrade. All are TCP payload
counts at the proxy: **TCP/IP, ACK-only packets, SSH, encryption and retransmissions
are excluded**. Those are not full-network byte totals. Reconnect totals include
bytes offered to the proxy on abandoned connections, even if discarded from its
queue before simulated-link delivery.
The recorded endpoint queue maximum adds pending raw codec input and socket output;
it is a queue-storage diagnostic, not total RSS or decoder-context memory.

The report uses medians across fresh trials and preserves min/max ranges. There
are no tuned parameters selected from this corpus. The same production Channel
and same fixed source messages are used in both zstd transports. A compact
comparison and links to raw evidence appear in [report.md](report.md).
