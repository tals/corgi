# Reproduce the WebSocket codec comparison

This compares the real applications through SSH, using the same external network
lab and viewer-PTY observer as the earlier network evaluation. Corgi's three
primary builds differ only in compression selection. Herdr is stock v0.9.5,
with its normal `ssh -C` and the installed OpenSSH 9.6p1 client.

| Arm | WebSocket payload | SSH compression |
| --- | --- | --- |
| WS uncompressed | Existing JSON byte stream | Off |
| WS zstd | Existing live-history zstd, level 3, 1 MiB window | Off |
| WS native deflate | Bun 1.4.4 native `permessage-deflate`, dedicated contexts | Off |
| Herdr + SSH-C | Stock Herdr protocol, without WS | `zlib@openssh.com` |

All Corgi arms use the same two in-process Unix-socket adapters and HTTP upgrade.
No extra Bun processes are omitted from CPU accounting. The zstd arm uses an
application subprotocol over binary WS messages, **not a standardized zstd WS
extension**. There is no trained dictionary. Native deflate uses context takeover
in both directions; Bun's small-client-message compression threshold still applies.

## Commands

Requirements: Linux network namespaces, `tc`, `ip`, `ss`, OpenSSH client/server,
`tcpdump`, passwordless sudo for isolated namespaces, Bun 1.4.4, Python 3, and
this repository's built native layer. The main checkout is not modified by
`prepare.py`; it creates a detached worktree and retains every build patch.

```sh
bun test ./src
bun test ./tools/benchmarks/remote_network/websocket_codecs
bun typecheck.ts

python3 tools/benchmarks/remote_network/websocket_codecs/prepare.py \
  0ab9600e dist/websocket-codecs-builds

bun tools/benchmarks/remote_network/websocket_codecs/send_probe.ts \
  dist/websocket-codecs-send-proof.json

# Run separately from the timed matrix: packet captures and negotiation proof.
for codec in identity zstd deflate; do
  python3 tools/benchmarks/remote_network/websocket_codecs/diagnostic.py \
    corgi "dist/websocket-codecs-builds/corgi-$codec" \
    "dist/websocket-codecs-diagnostic/$codec"
done
python3 tools/benchmarks/remote_network/websocket_codecs/diagnostic.py \
  herdr /absolute/path/to/herdr-v0.9.5 dist/websocket-codecs-diagnostic/herdr
python3 tools/benchmarks/remote_network/websocket_codecs/proof.py \
  dist/websocket-codecs-diagnostic dist/websocket-codecs-proof.json

python3 tools/benchmarks/remote_network/websocket_codecs/matrix.py \
  dist/websocket-codecs-builds/corgi-identity \
  dist/websocket-codecs-builds/corgi-zstd \
  dist/websocket-codecs-builds/corgi-deflate \
  /absolute/path/to/herdr-v0.9.5 dist/websocket-codecs-network \
  --zstd-raw dist/websocket-codecs-builds/corgi-zstd-raw

python3 tools/benchmarks/remote_network/websocket_codecs/audit.py \
  dist/websocket-codecs-network dist/websocket-codecs-reduction
python3 tools/benchmarks/remote_network/websocket_codecs/cpu.py \
  dist/websocket-codecs-network \
  tools/benchmarks/remote_network/websocket_codecs/evidence/cpu.json
python3 tools/benchmarks/remote_network/websocket_codecs/publish.py \
  dist/websocket-codecs-reduction tools/benchmarks/remote_network/websocket_codecs
```

Use fresh output directories. The default matrix has 15 suites × four arms ×
three repetitions = 180 independent labs. Each lab gets two physical cores;
the default CPU range is 8–127. The runner rejects allocations that overlap
physical cores through SMT, and rotates products across CPU sets between repeats.
Use `--suites stream-20,stream-120` for the smaller bandwidth subset. Choose a
CPU range appropriate for the host. For a suite subset, inspect the audit’s
`summary.json`; the overview publisher expects the full default matrix. A shared benchmark lock prevents independent
benchmark runners from overlapping. Interrupt the matrix process so children
can clean up their private daemons, SSH keys, directories and namespaces.

The positional labels retained in raw files are `before` = uncompressed,
`after` = zstd, `control` = native deflate, and `herdr` = Herdr + SSH-C.
The two `accounting-*` suites substitute `corgi-zstd-raw` for `after`; they are
sensitivity controls, not extra repetitions of the main zstd implementation.

## What the measurements mean

- **Bandwidth:** receiving-interface byte deltas on the selected machine's
  actual SSH link, separately downstream/upstream and summed. This includes
  Ethernet, IP, TCP, SSH framing/encryption and ACKs. Each delivered packet is
  counted once. Packets lost inside the shaping fabric are not counted as
  delivered bytes. The independent diagnostic sums packet lengths from captures,
  correcting Linux's cooked-capture header to Ethernet's header, and compares
  them with the interface counters. It also verifies actual negotiated SSH/WS
  codecs and WS RSV1/masking bits. Diagnostic tracing/capture is disabled in
  timed trials.
- **Delivered cadence:** uniquely marked source updates observed after the real
  viewer renders to its PTY. Header/footer sequence numbers must match. This is
  not a send count or render-loop callback count. Dense output changes 22 rows
  of 108 pseudorandom alphanumeric characters per update; sparse output changes
  a rotating build-status line and restores the preceding line. Both include
  timestamp, sequence and input-echo markers. The normal source rate is 20 Hz;
  the high-latency cadence suite uses 60 Hz. The same deterministic generator,
  dimensions and seed are used for all products. These are controlled terminal
  workloads, not a distribution of real agent sessions.
- **Display age:** wall-time sampling every 50 ms, including periods where a
  stale frame remains on screen. Reporting only arriving-frame latency would
  hide stalls. Always interpret constrained-link bandwidth alongside FPS/age;
  sending less because fewer updates are delivered is not better compression.
- **Startup:** first remote tab UI (visible seeded tab labels) and first marked pane content from actual
  PTY observations. `cold-ui` has no prior remote layout or SSH master. Other
  startup cases distinguish a new SSH connection from a warm master; saved
  layout can appear before fresh content. Navigation includes unseen tabs and
  cached returns. Full definitions and ranges are in [measurements](measurements.md).
- **Recovery:** time after restoring connectivity until a fresh screen and a
  newly typed input echo are visible. Inputs also have independent durable
  remote receipts. A missing observation stays missing. Short/long blackholes,
  downstream-only failure, TCP reset, unaffected-machine interaction, continuous
  bandwidth changes, and 180-second client freezes are included.
- **Freeze:** client processes stop, the link drops packets, and server TCP
  state is removed. Remote work must keep running. This is a specific sleep
  simulation; kernel timers continue. The two variants send or omit an input
  immediately before the freeze. They do not assert a particular TCP ACK state;
  see the [prior packet-level explanation](../websocket_app/sleep-interpretation.md).
- **CPU/RSS:** all application daemons and viewer, including WS adapters.
  The separate `cpu.py` reduction also counts the SSH client/master/server and
  native bridge, so Herdr’s compression process is included. Producers, the
  observer and kernel/network work not charged to these processes are excluded.
  CPU is average cores consumed, not percent of an arbitrarily sized host.
  Summed RSS can double-count shared pages. These measurements cannot isolate
  compressor-only cost; the [identical-payload component test](../websocket_eval/report.md)
  measures the codec integration separately.

## Accounting control and prototype limits

Bun's WS `send()` returns the uncompressed message length. Its API does not
expose per-message compressed length for the adaptive frame controller.
The native-deflate arm therefore retains the existing identity path's raw-byte
accounting. Zstd normally reports actual compressed lengths. The `zstd-raw`
control changes only that accounting callback, letting us test whether observed
FPS/backpressure differences come from the controller rather than compression.
No shadow compressor or guessed ratio is used to advantage native deflate.

The WS adapter frames socket chunks, which can coalesce multiple JSON messages.
It bounds queues to 4 MiB. Tests cover final-byte preservation, bidirectional
backpressure, abrupt disconnect, a compressible 2 MiB application-flight burst,
and explicit disconnection when a larger compressed burst expands beyond the
receive bound. Pause cannot undo frames already read by Bun. This overflow path
requires production consideration; a successful normal-workload benchmark does
not establish arbitrary-burst support.

This remains an evaluation build. Planned daemon handoff and TCP half-close
semantics are not implemented for WS. The production application source is
unchanged by this experiment. Actual codec settings, build hashes, exact patches,
network observations and original per-trial results are retained as evidence.

[Raw evidence archive and verification](artifacts.md) · [Severe-link scheduling control](backpressure.md).
