# Reproduce the short-outage investigation

See the [report](report.md), [diagnosis](diagnosis.md), and the
[original prerequisites/topology](../README.md). Tools include Bun, the pinned
native toolchain, OpenSSH client/server, Linux network namespaces, `tc`,
passwordless `sudo` for the private lab, and `tcpdump` for packet diagnostics.
Host routes, interfaces and application code are not altered to inject faults.

## Binaries

Normal Corgi is `35cef14d`. Herdr is the official unmodified v0.9.5 Linux x64
binary, SHA-256
`14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`.
Its source was inspected at `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`.

Build normal Corgi and the deliberately unsafe diagnostic in separate
worktrees. Apply the diagnostic patch only in its throwaway checkout:

```sh
git worktree add --detach ../corgi-short-normal 35cef14d
git worktree add --detach ../corgi-short-ablation 35cef14d
(cd ../corgi-short-normal && bun install --frozen-lockfile && bun build.ts)
git -C ../corgi-short-ablation apply \
  "$PWD/tools/benchmarks/remote_network/short-outages/evidence/no-receipts.patch"
(cd ../corgi-short-ablation && bun install --frozen-lockfile && bun build.ts)
```

The ablation disables frame receipts and outstanding-frame limits. It exists
only to measure the cause; do not use it as a replacement for normal Corgi.
Build the report checkout too if the observer's native library is absent.

## Repeated comparison

```sh
python3 tools/benchmarks/remote_network/outages.py \
  ../corgi-short-normal/dist/corgi \
  ../corgi-short-ablation/dist/corgi \
  /path/to/herdr-v0.9.5 /tmp/corgi-short-comparison \
  --repeats 3 --cases blackhole2,blackhole3,blackhole4,blackhole5,blackhole7

python3 tools/benchmarks/remote_network/outage_report.py \
  /tmp/corgi-short-comparison /tmp/corgi-short-report/evidence
```

The coordinator's historical labels are `before` = normal Corgi, `after` =
**diagnostic without receipts**, `herdr` = unchanged release. The generic
reporter also uses before/after labels; it does not mean the diagnostic is a
fix. The checked-in report names that distinction explicitly.

Each round creates three independent labs, rotating disjoint CPU sets
`32-39;48-55;64-71`. Override with `--cpu-sets` for your machine. A shared lock
serializes benchmark coordinators. Performance runs disable tracing/capture.
Each case starts a fresh viewer; daemons and workloads persist within a lab.
There are four producers per machine, three machines, and a selected remote
PTY of 132 × 47. The sparse workload updates at 20 Hz with 120 ms RTT.

The harness types during loss at one second for the two-second case and at
two seconds for longer cases, restores
the link, requires a fresh complete screen, and then measures a unique remote
input echo. Reports retain actual fault duration, independent input logs,
process survival, binary hashes and harness snapshots. This is fixed timing
within each case, not a randomized Internet outage distribution.

## Packet and application diagnostics

Run separately from performance measurements, with a fresh output directory:

```sh
python3 tools/benchmarks/remote_network/run.py corgi \
  ../corgi-short-normal/dist/corgi /tmp/corgi-short-trace \
  --suite faults --repeats 1 --fault-cases blackhole3 \
  --cpus 32-39 --trace --capture
python3 tools/benchmarks/remote_network/packet_timeline.py \
  /tmp/corgi-short-trace /tmp/corgi-short-packets.json
python3 tools/benchmarks/remote_network/outage_timeline.py \
  /tmp/corgi-short-trace /tmp/corgi-short-timeline.json
```

Repeat with product `herdr` and its binary for packet/TCP evidence. Herdr's
application source and binary remain unchanged. `--capture` records the first
128 bytes of packets in the client and Atlas namespaces (TCP headers plus
any payload prefix); the capture includes encrypted SSH traffic and ARP.
`packet_timeline.py` uses `tcpdump` to decode headers and aligns epoch times
with the harness's fault events. Check the retained capture logs for drops.
`--trace` enables Corgi's existing filtered `remote.*` timeline and periodic
TCP state samples. Both are optional and off in the repeated comparison.

The single-use warm-spare prototype is in
[evidence/warm-spare.patch](evidence/warm-spare.patch), also based on `35cef14d`.
Do not combine it with the early-spare patch; it already includes those changes.

The early-spare experiment is reproducible by applying
[evidence/early-probe.patch](evidence/early-probe.patch) to another detached
`35cef14d` worktree. The large-window experiment changes only `Frames.available`
to 256 frames/1 MiB and the offer byte gate to 1 MiB. These rejected pilots are
kept separately from the repeated comparison. Binary manifests distinguish
intermediate builds; rebuilding later need not produce byte-identical binaries.

[Raw archives and hashes](evidence/artifacts.json) retain captures, logs,
harness copies and complete results. Private SSH keys are removed during lab
cleanup and are not archived.

The first attempted repeated comparison stopped on a harness `/proc` lookup
race while resetting SSH between cases. `reset_ssh` now tolerates a process
exiting between enumeration and inspection. That interrupted comparison is
retained separately; the final comparison was restarted in nine fresh labs.

TCP snapshots now run asynchronously, starting two seconds before the intended
restoration. They finish independently of restoration; the measurement clock
never waits for them. The duration audit requires restoration within 0.75 s of
the configured deadline. Earlier pilots used synchronous snapshots and their
nominal two-second cases actually lasted about 3.3 s. Those matrices are kept
as diagnostics, not pooled into the corrected final sweep.
