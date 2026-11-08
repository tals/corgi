# What changed

The production Corgi viewer now uses live-history zstd and an adaptive delivery
window over its existing SSH connection. These are application changes, not an
external compression wrapper. Herdr remains unmodified.

- [Compression](../../../../src/wire_compression.ts): Bun's built-in `node:zlib`
  zstd stream, level 3, 1 MiB history, flushed after each message. No trained
  dictionary or training corpus. Both peers negotiate in the existing hello
  exchange; older peers can remain plain. Local sockets remain plain.
- [SSH](../../../../src/ssh.ts) and [remote transport](../../../../src/daemon_transport.ts):
  disable SSH compression on these attachments and use a separate SSH master
  namespace. CLI SSH retains its previous compression setting. The diagnostic
  run verifies actual negotiation, not just command-line intent.
- [Delivery controller](../../../../src/viewer_stream.ts): frame allowance covers
  baseline RTT at the 16 ms publication cadence, grows cautiously, and shrinks
  when queueing appears. Actual encoded bytes refine a separate byte allowance.
  Caps are 64 frames, 512 KiB estimated wire flight, and 2 MiB raw outstanding
  data; one oversized frame may proceed alone. Encoder and socket queues have
  separate bounds. Blocked updates coalesce to the latest screen.
- The controller drains outstanding frames before sending a small RTT probe.
  This distinguishes changed propagation delay from old queued work. A two-second
  peak delivery estimate prevents a small window from reinforcing its own low
  rate. Tests reproduce the sparse-to-dense, 300/600 ms RTT transitions that
  exposed that failure during development.
- [Connection setup](../../../../src/machine_connection.ts) pipelines link setup
  and metadata snapshot when no mutation needs replay, saving a round trip.
- [Live upgrades](../../../../src/persist/handoff.ts) preserve the daemon identity
  and viewer links. Compression contexts restart on a new connection. A planned
  reconnect notice lets the viewer hold up to 64 KiB of typing for at most the
  startup timeout, and release it only after the same viewer resumes. Machine,
  focus, navigation changes or an expired hold discard it. Ordinary outages keep
  the existing input-discard policy. The reconnect integration tests check that
  panes survive and delivered input appears exactly once.
- [Telemetry](../../../../src/telemetry.ts): `wire.compress` records output bytes
  and encoding elapsed time; `remote.stream.window` records frame and byte
  budgets, pending work, RTT, delivery estimate, congestion and probes.

The row-delta protocol and metadata representation are unchanged. Compression
reduces their repeated bytes; this does not make the logical protocol cell based.
There is no extra native library or FFI compression shim. The native SSH bridge
continues to relay opaque bytes.

The hello fields and handoff instance field are optional; runtime/viewer and
saved-format versions are unchanged. An older handoff without the instance field
still receives a new identity. A new viewer connecting to an older daemon falls
back to plain application traffic; its attachment still disables SSH compression,
so mixed-version bandwidth is not represented by this same-version benchmark.

# Limits and next bottlenecks

This controller is a bounded freshness policy above TCP, not a replacement for
TCP congestion control. It cannot retract bytes already accepted by SSH/TCP.
An abrupt capacity collapse can therefore cause a transient queue even when
steady-state delivery is well behaved. At 600 ms RTT and 64 kbit/s, the accepted
build delivers 2.8 updates/s versus the previous build's 1.9, but P95 displayed
content age rises from 1.32 to 1.80 seconds. The current probe/window policy still
needs tuning at this extreme. The main report includes this regression. The continuous-change suite retains that
transient; ordinary stream samples omit four seconds of settling.

Short blackholes and the random-loss case remain weaker than Herdr in these
measurements. Sparse traffic also still spends substantially more upstream bytes
on Corgi's acknowledgement/control machinery. Those are distinct next targets;
the compression change does not resolve them by itself. Corgi's total product
CPU and resident memory remain higher than Herdr's, even when network traffic is
lower. See the full measurements before treating bandwidth savings as total
resource savings.

# Evidence and scope

The main comparison uses three repetitions of each of 13 suites for each of three
binaries: 117 independent labs, plus nine separate 600 ms/64 kbit/s edge-case labs. Each lab has a viewer, local daemon, two remote
daemons and four producers per daemon. All impairment is outside application
code, on isolated Linux network links. Network counters and actual visible PTY
markers establish the results; remote input receipts independently check delivery.

[Distributions and trial links](measurements.md) · [Audit](evidence/audit.json) ·
[Transport negotiation](evidence/transport.json) · [Validation](evidence/validation.json).

Earlier controller candidates and an interrupted candidate matrix are retained
under `dist/adaptive-*`, but are not pooled into this report. In particular,
`adaptive-production-20261108` and `adaptive-extra-20261108` contain the earlier
rate-estimator stall. `adaptive-release-20261108` was stopped after the upgrade
regression surfaced. The report uses only `adaptive-accepted-20261108`.
