# Short outages: where the time goes

This investigation starts from Corgi `35cef14d`, which already contains the
long-outage fixes. Herdr is the unmodified v0.9.5 release, source commit
`2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`. No Herdr patch was made.

## Both products use OpenSSH

Herdr's [SSH options](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/remote/attach.rs#L1214)
use compression and connection sharing, as does [Corgi](../../../../src/ssh.ts).
Herdr's [health policy](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/client/endpoint/health.rs#L3)
sends a probe after five seconds without incoming messages, then allows ten
seconds for a reply. Its three-second result does not come from an aggressive
application reconnect timer.

The important difference is traffic and flow control. Herdr's
[writer](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/client_transport.rs#L950)
drains a replaceable render slot into the local transport; that slot does not
bound bytes already accepted by SSH and TCP. Corgi instead permits at most
three frames and 16 KiB of encoded JSON awaiting
[decoded-frame receipts](../../../../src/viewer_stream.ts). An oversized
snapshot travels alone. The viewer sends a
[receipt RPC](../../../../src/machine_stream.ts) for each decoded frame.
This bounds stale screens in the network and is why the previous bandwidth
fix works. It also makes normal streaming carry application data in both TCP
directions, even when the user is not typing.

## Packet captures locate the delay below the application

A separate diagnostic captured packets at both ends of the isolated Atlas
link. Times below are relative to link restoration; these trace runs are
**not pooled with the telemetry-disabled performance trials**.

| Event | Corgi | Herdr |
| --- | ---: | ---: |
| Observed fault window | 3.315 s | 3.287 s |
| First transmission on the old TCP connection after restoration | +2.050 s | +0.095 s |
| First fresh screen | +2.297 s | +0.520 s |
| Remote input echo | +2.473 s | +0.650 s |

The old TCP connection survives in both products. Corgi sends no packet on
that connection for the first two seconds after restoration. The captured
sequence ranges show retransmission of outstanding bytes, rather than a
viewer waiting two seconds to render bytes it already received. Before
restoration, Corgi's retries are already about 2.6–2.7 seconds apart. Its
receipt RPCs complete when those bytes finally arrive.
[Corgi packets](evidence/corgi-packets.json) ·
[Corgi RPC timeline](evidence/corgi-timeline.json).

Herdr's upstream connection is quiet until the harness types during the
outage, about two seconds after fault onset. Its first data retransmissions
therefore start later. Its downstream writer also continues sending new data
longer before TCP stops it. In this diagnostic both directions retransmit at
+0.095 seconds. These observations explain the favorable retry phase; they do
not imply a universal Herdr recovery bound.
[Herdr packets](evidence/herdr-packets.json).

## Controlled changes, including unsuccessful fixes

All diagnostic changes were made to Corgi and removed from the application
checkout afterward. Pilot durations are nominal: their synchronous snapshot
collection delayed restoration, particularly in the two-second cases, which
actually lasted about 3.3 seconds. The final comparison fixes that scheduling;
pilot values are not pooled with it. Their build manifests, trial metrics, raw-data paths and patches
are retained in [experiment evidence](evidence/experiments.json).

1. **Start a spare earlier.** After learned byte silence of at least 1.5 s,
   race a fresh SSH connection while retaining the primary. Partial incoming
   replies count as progress; a recovering primary wins. This did not improve
   the two- or three-second pilot results. In the traced three-second case,
   the spare starts at −1.362 s, its SYN finally succeeds at +0.722 s, and its
   `hello` completes at +2.495 s—after the original path has already resumed.
   At seven seconds the pilot also regressed (3.349 → 4.142 s). The extra
   attempt changes subsequent probe timing, so earlier is not always faster.
   [Spare packet trace](evidence/early-probe-packets.json) ·
   [Application phases](evidence/early-probe-timeline.json) ·
   [Rejected patch](evidence/early-probe.patch).
2. **Enlarge the frame window.** Raising the bound to 256 frames/1 MiB made
   the three-second pilot worse (2.383 → 3.111 s). Client receipt traffic
   still has outstanding bytes, and more stale screen data can accumulate.
3. **Remove receipts and their limits.** This diagnostic isolates their cost:
   suppress per-frame and periodic receipt RPCs, and remove the server's
   frame/byte gates. The repeated comparison includes this variant alongside
   normal Corgi and Herdr. It moves two-/three-second recovery much closer to
   Herdr, but gives up bounded backpressure and changes other retry phases.
   It is an ablation, not a proposed production fix.
   [Exact diagnostic patch](evidence/no-receipts.patch) ·
   [All measurements](measurements.md).
   An earlier run also missed one pre-outage input in the nominal two-second
   case. That superseded matrix remains in the experiment evidence; it is
   excluded from the corrected final comparison.
4. **Preauthenticate a spare.** A single-use warm SSH connection for the
   selected machine cut the pilot's three-second recovery from 2.503 to
   1.853 s, but seven-second recovery rose from 3.249 to 4.132 s. The early
   probe occupies the spare slot and shifts the subsequent fresh-dial timing.
   This demonstrates a possible benefit, not a validated replacement policy.
   The pilot adds an SSH connection, three SSH/sshd processes (about 16 MiB
   summed RSS in one pre-fault sample), and a remote bridge/shell. These are
   descriptive process samples, not unique physical-memory measurements.
   [Prototype patch](evidence/warm-spare.patch) ·
   [Resource samples](evidence/warm-resource-samples.json).

## What remains open

No production change from these experiments is retained. The existing
long-outage and backpressure fixes stay in place. The evidence does not
justify trading them away to win one outage duration or lowering a timer
that mostly waits for another SSH handshake.

A production warm-spare policy would still need replenishment, cancellation,
resource limits and coexistence with fresh dials after an address change or
long outage. The single-use prototype does not supply those guarantees. A
separate recovery transport is another, untested design direction. Merely
changing frame-window sizes or retry thresholds cannot promise fast recovery
across TCP retry phases.

The measurements are Linux simulations at 120 ms RTT, with fixed producer and
input timing. Varying outage length exposes phase sensitivity, but is not a
randomized field distribution or a test of physical Wi-Fi roaming. A useful
future transport change should beat the whole duration sweep while retaining
the low-bandwidth and exactly-once input checks.

## Fault scheduling correction

A late timing audit found that the harness waited for `ss`/`tc` snapshots
before restoring the link. Snapshot collection now runs independently of the
restoration deadline, and the audit allows less than 0.75 seconds of overhead
instead of two seconds. Applying that stricter check to the preceding matrix
rejects all nine nominal two-second trials. They remain archived, and the
final comparison restarts in nine fresh labs using the corrected scheduler.
[Failing duration audit](evidence/timing-before.json) ·
[Final measured durations](measurements.md).
