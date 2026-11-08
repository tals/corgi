# Reproduce control isolation

Run from the repository root with Bun and the existing native build. These
fixtures create disposable daemons, homes, sockets and pane producers. They do
not attach to the user's daemon or change host networking.

The retained baseline is `dist/corgi-control-before`: the previous HTTP/WS build
with one active-viewer connection. The candidate is
`dist/corgi-control-priority-final`. Binary SHA-256 values are recorded in each
manifest. Preserve a baseline binary **before** building a new candidate.

```sh
bun build.ts --no-native
cp dist/corgi dist/corgi-control-priority-final
cp dist/corgi.build.json dist/corgi-control-priority-final.build.json
bun tools/benchmarks/control_priority/run.ts \
  --before dist/corgi-control-before \
  --after dist/corgi-control-priority-final \
  --out dist/control-priority-verified
```

This runs three alternating before/after trials per combination of sparse/dense
output and plain/zstd WS. A real pane writes a 160×48 screen at 50 Hz. Each trial
warms for 1.5 seconds and measures six seconds. Matching header/footer sequence
numbers count complete updates; partial terminal writes do not count as extra
updates. An external Unix-socket proxy counts downstream bytes, including WS
framing, after warmup. Control pings use the actual viewer control connection.

Eight times per trial, the fixture pauses both Bun's native WS reader and the
Duplex wrapper for 250 ms, while continuing control calls. On the baseline that
reader serves both kinds of traffic. This models **a stalled pane consumer**,
not whole-process suspension. Zstd over Unix sockets isolates the codec and
socket queues; those numbers are not WAN/SSH latency measurements.

For the real viewer over SSH, use the existing network-namespace harness. It
requires Linux, OpenSSH, `ip`, `tc`, `ethtool` and configured passwordless sudo
for the harness's namespace commands. CPU set 32–39 must be available. The
1 Mbit/s cap applies to the shared link, not separately to each connection.

```sh
python3 tools/benchmarks/remote_network/run.py corgi \
  dist/corgi-control-before dist/control-priority-wan-before \
  --suite stream --repeats 2 --stream-rtt 300 --stream-seconds 12 \
  --stream-cases sparse:1mbit,dense:unlimited,dense:1mbit
python3 tools/benchmarks/remote_network/run.py corgi \
  dist/corgi-control-priority-final dist/control-priority-wan-verified \
  --suite stream --repeats 2 --stream-rtt 300 --stream-seconds 12 \
  --stream-cases sparse:1mbit,dense:unlimited,dense:1mbit
python3 tools/benchmarks/control_priority/summarize.py \
  dist/control-priority-verified dist/control-priority-wan-before \
  dist/control-priority-wan-verified tools/benchmarks/control_priority/evidence
```

Use fresh output directories. Run benchmarks sequentially; the harnesses share
a benchmark lock. Do not overwrite a binary while a trial uses it. The WAN
fixture uses the actual viewer PTY, three daemons, four producer panes per
machine and a nominal 20 Hz workload. It counts complete visible frames,
interface traffic including SSH/TCP overhead, echoed input, and catch-up after
lifting the cap. Independent producer logs check execution and duplicates.
Two WAN trials per condition are regression checks, not precise tail estimates.

To reproduce saturation, run `remote_network/run.py` for each binary with
`--suite stream --repeats 2 --stream-rtt 300 --stream-seconds 20
--stream-cases dense:64kbit --trace`, into fresh before/after directories. Then:

```sh
python3 tools/benchmarks/control_priority/pressure.py \
  dist/control-priority-pressure-before dist/control-priority-pressure-after \
  tools/benchmarks/control_priority/evidence/pressure.json
```

The retained saturation candidate is `dist/corgi-control-priority-release`, the
final test-drive build. Its pending-handshake watchdog was added after the
steady-state runs; [provenance](measurements.md#build-provenance) distinguishes
the measured binaries. Tracing measures control replies on the viewer's own
connection, not a separate administrative probe socket.

Validation:

```sh
bun test ./src
bun typecheck.ts
bun build.ts --test --no-native
bun integration.ts remote reloads rpc --jobs 1
CORGI_OLD_EXE="$PWD/dist/corgi-before-ws" \
  bun integration.ts rollback reload_compatibility --jobs 1
```

The unit tests in `src/viewer_data.test.ts` cover paused readers, independent
control commands, link binding, lane cleanup, handoff cache reset and concurrent
SSH setup. `tests/reloads.test.ts` checks that the active local viewer keeps both
WS connections across a real daemon replacement. `tests/remote.test.ts` checks
independent SSH transports, outages, reconnect races, input delivery and remote
reloads.
