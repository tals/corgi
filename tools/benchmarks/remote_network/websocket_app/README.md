# Reproduce the application WebSocket comparison

This experiment carries Corgi's existing live-history zstd byte stream over
**Bun's native WebSocket binary messages**. It is an application subprotocol,
not a native or standardized zstd WebSocket extension. SSH still supplies
authentication and encryption; SSH compression remains disabled for Corgi.
Stock Herdr v0.9.5 uses the installed OpenSSH client with compression enabled.

The four arms are the reviewed Corgi implementation, Corgi over WebSocket, a
plain adapter control, and stock Herdr. Both adapter arms add the same two Unix
socket hops inside the existing application processes. There are no extra Bun
processes. Their CPU and memory are included in product measurements. The
WebSocket prototype deliberately retains the ordinary application hello after
HTTP upgrade, so its additional setup round trip is included in startup results.

## Build and run

Requirements are the same as the [network evaluation playbook](../adaptive-production/README.md):
Linux network namespaces, `tc`, `ip`, `ss`, OpenSSH client/server, passwordless
sudo for the isolated lab, Bun 1.4.4, and the repository's built native layer.
Use an otherwise idle host. Each simultaneous lab gets four disjoint logical
CPUs; the full command below needs CPUs 16–175. These sets share some physical
cores through SMT, so small CPU differences are not evidence of a speedup.
Reduce the suite list or move
`--cpu-start` on a smaller host. Products rotate CPU sets between repetitions.

From this worktree, with the reviewed application commit `b0e34828` available:

```sh
bun build.ts --no-native --outfile dist/corgi-reviewed
python3 tools/benchmarks/remote_network/websocket_app/prepare.py \
  b0e34828 dist/websocket-app-builds

python3 tools/benchmarks/remote_network/websocket_app/matrix.py \
  dist/corgi-reviewed \
  dist/websocket-app-builds/corgi-websocket \
  dist/websocket-app-builds/corgi-raw \
  /absolute/path/to/herdr-v0.9.5 \
  dist/websocket-app-network \
  --suites cold-ui,startup,cadence,stream-120,stream-600,stream-600-low,transition,faults-sparse,sleep,sleep-clean \
  --cpu-start 16 --repeats 3

python3 tools/benchmarks/remote_network/websocket_app/audit.py \
  dist/websocket-app-network dist/websocket-app-reduction
```

Use fresh output directories. `prepare.py` creates an isolated worktree and
builds each prototype from the same committed application baseline. It saves
the exact source patches, binary/source hashes and build logs. Its source
changes are confined to transport adapters and their lifecycle hooks. It does
not change Corgi's frame controller, surface encoding, zstd settings, workload,
or rendering. The evaluated run used `dist/websocket-app-builds-final` instead
of the example build directory above; manifests retain the actual paths.

The direct benchmark binary was built before the review commit, so its embedded
Git label says `47bb46fe-dirty`. A separate clean rebuild of `b0e34828` verified
that all three bundled JavaScript entrypoints match after normalizing only
build metadata and generated source-path comments. See the
[equivalence proof](evidence/baseline-equivalence.json),
[rebuild identity](evidence/baseline-rebuild.json), and
[reproducible ELF extractor/comparator](compare_bundle.py).

The matrix uses the existing lab/observer/workload without editing application
code during a run. The shared benchmark lock prevents overlapping allocations.
Every lab has private home/config/state directories, SSH keys, daemons, panes,
and network namespaces, and cleans them up on completion. It does not attach
to the user's running Corgi or Herdr. Interrupt through the matrix process to
allow its child labs to clean up.

## What is measured

- The real viewer PTY supplies first tab/pane UI, first pane content, visible
  source frame markers, display age, and typed-input echoes. This includes the
  actual renderer and reconnect controller, not just codec replay.
- Linux `netem`/TBF shape the network between SSH endpoints, with offloads
  disabled. Caps are per direction. Receiving-interface counter deltas include
  SSH/TCP/IP traffic; both directions are reported separately and together.
  Each delivered packet is counted once. Packets dropped inside the shaping
  fabric are not counted as delivered traffic.
- Dense and sparse workloads run at 20 Hz, with a separate 60 Hz/300 ms case.
  Limited-bandwidth samples include time-weighted held-screen age, and the
  continuous capacity transition retains the entire recovery interval.
- Outages drop packets or reset server TCP state. Three-minute freezes stop
  client processes, drop packets, and remove server TCP state, both with and
  without a pending write. They are simulations of sleep, not physical suspend.
- Product CPU covers all three daemons plus the viewer, including the adapters;
  SSH and workload producers are excluded. Summed RSS double-counts shared pages.

The audit checks all scheduled labs, exit codes, payload/input evidence,
producer survival, cleanup, frozen harness identity, and binary identity. It
also verifies that adapter arms actually use bridge-backed profiles and the
`.transport` socket; profiles without a native bridge would bypass the prototype.
Do not treat a missing or failed trial as a fast recovery.

The [standalone codec/transport comparison](../websocket_eval/README.md) separately
compares native WebSocket deflate with zstd on identical captured/replayed
messages. Those CPU and byte results exclude full application and SSH costs;
they cannot establish application frame rate or wake-up behavior.

## Scope of the prototype

This is an evaluation build. It does not transfer WebSocket listeners or
connections during planned daemon handoff and does not preserve TCP half-close
semantics. Those are not claimed as supported. Cancellation, ordinary disconnect,
byte preservation, and bounded backpressure have focused adapter tests:

```sh
bun test tools/benchmarks/remote_network/websocket_app/adapter.test.ts
bun tools/benchmarks/remote_network/websocket_app/capabilities_probe.ts
```

The production branch keeps the reviewed stream transport while this experiment
evaluates adoption. Its compressed daemon reload path has separate production
integration tests. See [verified runtime capabilities](capabilities.md) for
extension support, framing, backpressure APIs, and primary specifications.
