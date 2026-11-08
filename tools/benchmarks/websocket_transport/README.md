# Local WebSocket transport

Local persistent RPC now uses **uncompressed WS over the existing Unix socket**.
Remote viewer RPC composes the same transport with the existing negotiated zstd
codec. HTTP POST hooks and raw management/legacy controls remain on that socket.

Five-trial medians, replaying captured pane updates through the production
`rpc.Connection` and `peer.Client` in two processes. No compression or SSH.
These measure transport/RPC costs, **not complete viewer rendering**.

| Local workload | JSON lines | Plain WS |
| --- | ---: | ---: |
| Sparse, 60 Hz: median reply latency | 0.327 ms | 0.416 ms |
| Dense, 60 Hz: median reply latency | 0.512 ms | 0.552 ms |
| Sparse, 60 Hz: combined CPU per update | 615 µs | 666 µs |
| Dense, 60 Hz: combined CPU per update | 761 µs | 823 µs |
| Sparse, saturated / 16 outstanding: replies/s | 20,835 | 19,330 |
| Dense, saturated / 16 outstanding: replies/s | 12,883 | 12,769 |

Both paths deliver every update at the requested 60 Hz. The CPU difference at
that rate is about **0.31 percentage points of one core for sparse output and
0.37 for dense**. Fresh local connection plus first reply takes approximately
0.43 ms raw versus 0.61 ms over WS in the paced trials. These are warm-process
opens, not app launch times. Steady-state latency ranges overlap across trials;
peak throughput is about 7% lower for sparse and 1% lower for dense in this run.
[All trials, latency distributions and CPU](evidence/local.json).

**Two connections can isolate a stalled reader.** With a 2 MiB render-like reply
and a 250 ms pause of its native reader, a ping takes **262 ms** on that same WS
versus **10.6 ms** on a separate WS. Both deliver the payload exactly.
[Five trials](evidence/isolation.json). This is a controlled local queue test,
not a remote application result. It excludes the second connection's setup and
does not model a shared SSH/TCP bottleneck. The active machine viewer therefore
retains its current single-connection layout; the older two-connection wrapper
also works over WS.

## What ships

- [Client adapter](../../../src/websocket_socket.ts): Bun's native client,
  bounded read/write queues, cancellation during upgrade, and final-byte delivery.
  Paths that Bun's Unix URL cannot represent literally use a private temporary
  symlink, removed after connecting or cancellation; the socket is still direct.
- [Server framing](../../../src/wire_websocket.ts): standard WS binary framing on
  the daemon's owned descriptor, including fragmented messages and partial-frame
  state that can cross a live handoff. It adds no socket relays.
  The server owns its descriptor instead of using Bun's opaque server WS object,
  so partial frames and the live connection can move to the replacement process.
- [RPC](../../../src/rpc.ts) accepts either a Unix path or a Duplex. Compression
  remains in [its own module](../../../src/wire_compression.ts); local connections
  do not instantiate a codec. Remote connections start fresh histories after
  reconnecting. WS framing contributes to the adaptive render-byte allowance.
- [Handoff](../../../src/persist/handoff.ts) keeps uncompressed connections alive,
  including subscriptions and queued replies. Format **7** migrates format 6;
  older candidates reject the new format. A bounded
  [rollback adapter](../../../src/persist/handoff_rollback.ts) retries format 6
  without WS connections. The old daemon must validate and commit before WS
  viewers/subscriptions are told to reattach with the selected older binary;
  running programs and raw connections survive. Compressed connections retain
  the existing planned reconnect and input handling on ordinary reloads.

WS carries the existing JSON-lines byte stream, so its headers are additional to
the newline: 2/4/10 bytes per server frame and 6/8/14 per client frame. Those are
protocol sizes, not new measured traffic claims. The native deflate extension is
disabled. Zstd, where selected remotely, is inside binary WS messages rather
than a standardized compression extension.

## Reproduce

Requires Linux, Bun 1.4.4, the repository's native libraries, and `taskset`.
Choose two permitted CPU IDs with `--cores`; this run used 176 and 177. The
processes communicate directly through a private temporary Unix socket, with
no root privileges and no connections to an existing Corgi daemon.

```sh
bun tools/benchmarks/websocket_transport/local.ts \
  --cores 176,177 --trials 5 --out dist/local-websocket.json
bun tools/benchmarks/websocket_transport/local.ts \
  --cores 176,177 --trials 5 --scenario isolation --out dist/ws-isolation.json

bun test ./src
bun typecheck.ts
bun build.ts --test --no-native
bun integration.ts rpc reloads viewers remote --jobs 1
```

To also check upgrades from a pre-WS local daemon, point `CORGI_OLD_EXE` at its
binary and run `bun integration.ts reload_compatibility --jobs 1`. The recorded
run used the previously reviewed `dist/corgi-reviewed` binary; its hash is in the
manifest. This is local upgrade compatibility, not support for an older remote
release.

Each arm loads the same SHA-verified [sparse/dense corpus](../remote_network/websocket_eval/fixtures/manifest.json),
warms 100 requests, then measures either 246 replies at 60 Hz or 2,460 replies
with at most 16 outstanding. Every decoded payload is compared with its source
after timing. CPU includes both endpoint processes, JSON encoding/decoding and
benchmark scheduling, but excludes process startup, warmup and post-run payload
verification. Raw/WS order alternates across trials. No bandwidth cap, trained
dictionary or HTTP/SSH compression is involved.

The [paused-reader tests](../../../src/websocket_peer.test.ts) transfer 8 MiB
downstream with less than 600 KiB of daemon queued output, and 2 MiB upstream
after a pause, checking order and contents. The
[parser tests](../../../src/wire_websocket.test.ts) reconstruct upgrades and
fragmented messages across every split position in representative exchanges.
[RPC integration](../../../tests/rpc.test.ts) verifies live subscriptions,
viewer identity, pending requests and replies across actual daemon replacement.

## Validation evidence

The [validation record](evidence/validation.json) links commands and complete
logs. Unit tests and typechecking pass. RPC/reload integration passes after
fixing old-daemon bootstrap paths and a migration default found by the broader
run. The broader run also passed all viewer tests except one configured skip,
and 43 of 44 SSH tests. The remaining SSH prediction test exceeded its immediate
preview deadline; it passed on an isolated rerun without a code fix. This is a
timing-sensitive result, not a claim of an entirely clean broad integration run.

[Environment and source hashes](evidence/manifest.json) identify the measured
implementation. The report does not establish new end-to-end remote or Herdr
performance numbers; it measures the local transport change and queue isolation.

The [rollback follow-up](evidence/rollback.json) records the real old-binary
upgrade/rollback and failure-path checks. This adapter changes handoff behavior;
the transport benchmark above remains the measurement of its original commit.
