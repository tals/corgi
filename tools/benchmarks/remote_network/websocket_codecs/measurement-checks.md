# Checks on what is actually measured

The headline bandwidth numbers come from **receiving network interfaces**, not
`send()` return values, uncompressed JSON sizes, or codec estimates. They include
both directions of the selected SSH connection and its Ethernet/IP/TCP overhead.
The workload and the real rendered viewer determine delivered FPS and screen age.

The separate [diagnostic proof](evidence/proof.json) passed 143 checks:

- Packet-capture byte sums agreed with interface counters within **1.02%** across
  every dense/sparse diagnostic and direction. Captures reported zero kernel
  drops. The small difference includes snapshot-read timestamp skew. The parser
  corrects Linux's synthetic capture header to the Ethernet header counted by
  the interfaces. These are delivered bytes, not an estimate of radio airtime.
- SSH logs show `none` for Corgi and `zlib@openssh.com` for stock Herdr. HTTP
  responses and actual WS RSV1 bits show native deflate operating only in its
  assigned arm. Its negotiated extension omits the no-context-takeover flags.
- The zstd arm offers/selects zstd in the application hello, with WS deflate
  disabled. The identity and native-deflate arms do not offer application zstd.
  All three use the native bridge and WS transport sockets.

Bun's return value is demonstrably unsuitable as a compressed-byte measurement:
the [isolated send probe](evidence/send-proof.json) sends 100,000 repeated bytes,
receives them exactly, and observes a **116-byte compressed WS payload**, while
`send()` returns **100,000**. [Probe source](send_probe.ts).

This also matters to Corgi's adaptive window. Native deflate is below the current
accounting hook, so it sees raw sizes. The extra `accounting-*` trials run zstd
with only that accounting callback changed to raw sizes. Their results are
kept separate from the main cohort. They do not use a shadow compressor or
fabricated compressed-size estimate.

Native-deflate captures show nearly all small upstream WS messages with RSV1
clear, while every server binary message has RSV1 set. This verifies the live
application's asymmetry, rather than assuming that negotiating compression makes
every message compressed. The [runtime capability investigation](../websocket_app/capabilities.md)
links Bun's pinned client implementation and its small-message threshold.

Diagnostic capture, WS parsing and telemetry are disabled in timed trials.
The [main audit](evidence/audit.json) checks scheduled trials, original results,
input receipts, producer survival, cleanup, binary/source identity, actual SSH
commands, bridge paths, rotating CPU assignments and disjoint physical cores.
The exact [environment](evidence/environment.json), [builds](evidence/builds.json),
and prototype patches are retained; Herdr's checkout is clean.

The adapter tests explicitly distinguish valid backpressure from overflow:
8 MiB of incompressible data transfers exactly through a paused reader; a
compressible burst at the application's 2 MiB raw-flight cap transfers exactly;
an 8 MiB highly compressible burst can exceed the 4 MiB receive queue and is
required to close. Passing the application matrix does not establish support
for arbitrary compressed bursts or planned daemon handoff.

See the [raw evidence archive](artifacts.md) and [playbook](README.md) for workload definitions, sampling windows and
commands. The earlier [identical-payload component benchmark](../websocket_eval/report.md)
isolates codec integration cost; it is not substituted for application CPU here.

## CPU includes the compression process

These are CPU cores consumed at equal 20 Hz delivered cadence on the uncapped link, medians of three trials. The combined column includes all product daemons/viewer, Corgi’s native bridges, and SSH client/master/server processes. Herdr’s SSH compression therefore counts. The detailed measurement table separately retains application-only CPU.

| Workload | Mode | Application cores | SSH + bridge cores | Combined cores |
| --- | --- | ---: | ---: | ---: |
| dense | WS zstd | 0.235 | 0.009 | 0.244 |
| sparse | WS zstd | 0.239 | 0.009 | 0.247 |
| dense | WS uncompressed | 0.223 | 0.010 | 0.232 |
| sparse | WS uncompressed | 0.229 | 0.009 | 0.239 |
| dense | WS native deflate | 0.230 | 0.009 | 0.238 |
| sparse | WS native deflate | 0.230 | 0.009 | 0.239 |
| dense | Herdr + SSH-C | 0.097 | 0.012 | 0.109 |
| sparse | Herdr + SSH-C | 0.062 | 0.004 | 0.066 |

[All 48 CPU samples, ranges and selected process rosters](evidence/cpu.json) are derived from retained `/proc` user+system tick counters. Process rosters were stable at both endpoints of every sample. Product-only and combined CPU use the same endpoints. Medians of separate columns need not sum exactly.

The busiest selected 30-second namespace sample used 0.652 of its two allocated cores, including producers and shells. This provides headroom evidence, not proof that scheduling jitter is absent. Observer CPU and kernel/network-fabric work not charged to these processes remain excluded. The four-core control changes host concurrency too; it is not a clean CPU-only causal experiment.

Reproduce with [cpu.py](cpu.py); the command is in the [playbook](README.md).
