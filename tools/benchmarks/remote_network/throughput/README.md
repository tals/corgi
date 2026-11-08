# Reproduce the throughput and recovery comparison

See the [main report](report.md) and [all measurements](measurements.md).
The [original playbook](../README.md) describes prerequisites and the isolated
network topology: Linux network namespaces, OpenSSH, `tc`, Bun and Corgi's pinned
native build. The harness uses real application binaries and real SSH. Faults
and bandwidth limits are applied outside application code. Herdr is unmodified.

## Builds

The baseline is Corgi `35cef14d`. Build it in a separate worktree. Build the
candidate from this report's branch, or apply
[the exact application patch](evidence/adaptive.patch) to a second `35cef14d`
worktree. Herdr is the official v0.9.5 Linux x64 binary, SHA-256
`14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`.
[Build manifests](evidence/builds.json) identify the binaries actually measured.

```sh
git worktree add --detach ../corgi-throughput-before 35cef14d
git worktree add --detach ../corgi-throughput-after 35cef14d
git -C ../corgi-throughput-after apply \
  "$PWD/tools/benchmarks/remote_network/throughput/evidence/adaptive.patch"
(cd ../corgi-throughput-before && bun install --frozen-lockfile && bun build.ts)
(cd ../corgi-throughput-after && bun install --frozen-lockfile && bun build.ts)
# The report checkout also needs native dependencies for its terminal observer.
bun install --frozen-lockfile
bun build.ts
```

## Matched trials

Use a new output directory:

```sh
python3 tools/benchmarks/remote_network/throughput_matrix.py \
  ../corgi-throughput-before/dist/corgi ../corgi-throughput-after/dist/corgi \
  /path/to/herdr-v0.9.5 /tmp/corgi-throughput --repeats 3
```

This serializes suites under the shared benchmark lock. Each suite compares
before, after and Herdr simultaneously on disjoint CPU sets, rotating the
products through `32-39;48-55;64-71` each round. On the measurement host we added
`--parallel`: bandwidth/RTT trials use those sets, dense outages use
`72-79;80-87;88-95`, and sparse outages use `96-103;104-111;112-119`.
These suites overlap on 72 distinct CPUs. There are three independent labs per
product per suite; tracing and packet capture are disabled. For other CPU
layouts, run `outages.py` directly with `--cpu-sets`.

```sh
# A smaller targeted comparison, using the same three positional binaries:
python3 tools/benchmarks/remote_network/outages.py \
  /path/to/before /path/to/after /path/to/herdr /tmp/corgi-throughput-targeted \
  --suite stream --stream-rtt 120 --repeats 3 \
  --stream-cases dense:1mbit,dense:256kbit,dense:64kbit
# For outages: --suite faults --fault-kind dense
#             --cases blackhole2,blackhole3,blackhole4,blackhole5,blackhole7,blackhole35
```

Each lab runs four workloads on each of three machines. The selected remote
PTY is 132 × 47. Every producer updates at 20 Hz. Dense output replaces 22 rows
of 108 pseudorandom ASCII characters; sparse output changes a progress row.
The observer decodes the actual viewer terminal through Ghostty and only accepts
a frame with matching header/footer sequence markers. It uses the same monotonic
clock as the producer. This is an update-delivery benchmark with a 20 Hz ceiling,
not a maximum-throughput benchmark above 20 Hz.

Stream cases measure 30 seconds after four seconds of settling. The displayed
screen's age is sampled every 50 ms, **including freezes**, so a stuck old screen
cannot improve its score by emitting fewer frames. Reported p95 lag is the median
of each trial's wall-time p95, not a percentile pooled across trials. Five unique
inputs per case have independent producer receipts. Visible echoes can be
missing from the observation window on very stale displays; those remain in the
results. After lifting the cap, catch-up requires a complete screen generated
after restoration and no more than 500 ms old. Both products use the same TBF
and netem reconfiguration procedure; this is a synthetic cap transition.

Outages drop all packets to one machine for the configured duration. The harness
restores the link on schedule, independently of TCP diagnostics. A fresh complete
screen and then a unique remote input echo establish recovery. Sparse and dense
outages are separate matched suites. Their retry timing is deliberately fixed;
the results are not a randomized distribution of real Internet outages.

## Reduce and audit

```sh
for suite in stream-120 stream-20 stream-300; do
  python3 tools/benchmarks/remote_network/throughput_report.py \
    /tmp/corgi-throughput/$suite /tmp/corgi-throughput-report/$suite/evidence
done
for suite in faults-dense faults-sparse; do
  python3 tools/benchmarks/remote_network/outage_report.py \
    /tmp/corgi-throughput/$suite /tmp/corgi-throughput-report/$suite/evidence
done
```

Audits check every scheduled case, exact binary and harness hashes, CPU rotation,
clock consistency, selected PTY dimensions, live producers, cleanup and independent
input receipts. Outages additionally check producer PID continuity and actual
loss duration. Missing cases or harness errors fail the audit. Three trials give
ranges and medians; they do not establish statistical equivalence.

## Additional bandwidth and sleeping-client comparisons

Run these as standalone coordinators after the main matrix. Each coordinator
owns the benchmark lock for its whole lifetime.

```sh
python3 tools/benchmarks/remote_network/outages.py \
  /path/to/before /path/to/after /path/to/herdr /tmp/corgi-bandwidth \
  --suite stream --repeats 3 --stream-cases sparse:unlimited,sparse:1mbit \
  --cpu-sets '72-79;80-87;88-95'
python3 tools/benchmarks/remote_network/throughput_report.py \
  /tmp/corgi-bandwidth /tmp/corgi-throughput-report/bandwidth/evidence
python3 tools/benchmarks/remote_network/outages.py \
  /path/to/before /path/to/after /path/to/herdr /tmp/corgi-sleep \
  --suite sleep --sleep-seconds 180 --repeats 3 \
  --cpu-sets '0-7;8-15;120-127'
```

The measured sleep comparison was split into one round and two additional
rounds, with the CPU rotation continued (`8-15;120-127;0-7` for the latter).
All three are included. The harness freezes every client-side process with
SIGSTOP, kills the old SSH TCP connections, then restores networking and sends
SIGCONT after 180 seconds. This is a process/network simulation, not physical
laptop suspend. All remote producers must remain alive and active, and the
pending input must execute exactly once. `summarize.py` includes those continuity
and input checks in each trial's sleep result.

Bandwidth includes **both directions** of the selected machine's link, using
interface byte counters around the steady sampling interval. It includes SSH,
TCP acknowledgements and control traffic, not just terminal payload. The two
counter intervals are sampled separately; total kbit/s adds their average rates.
Amortized wire bytes/update divides total bytes/s by displayed updates/s over the
steady window. It is not an encoded-frame size. Compare equal-rate, fresh displays
first; low-bandwidth Herdr frames can be much older despite a higher update count.

**RTT setup note:** `fresh_viewer()` establishes streams at 120 ms RTT, then the
stream case applies its requested RTT. Thus the 20 and 300 ms controls are
120→20 and 120→300 ms path changes followed by four seconds of settling. In
particular, the 300 ms result includes the adaptive sender retaining its faster
learned baseline; it is not a cold stream established at 300 ms. The original
120 ms comparisons do not change RTT.

## Window telemetry

Run separately from timing trials:

```sh
python3 tools/benchmarks/remote_network/run.py corgi /path/to/after \
  /tmp/corgi-throughput-trace --suite stream --repeats 1 --cpus 32-39 --trace \
  --stream-cases dense:unlimited,dense:1mbit,dense:256kbit,dense:64kbit
```

The existing telemetry system now records `remote.stream.window` when its byte
budget changes, including the observed receipt round trip and the fastest receipt
on that stream. It adds no wire fields. Duplicate receipts do not retrain it.
The limit is 16 KiB initially, 32 KiB when the latest receipt is within 50 ms of
the fastest, and 16 KiB otherwise. Three frames is always the ceiling, and a
single oversized snapshot can still progress alone. The fastest value lives
only for that stream; a persistent base-RTT increase can hold it at the smaller
budget until the stream is replaced. This is a bounded queue-delay heuristic,
not an estimate of available bandwidth.

The trace is excluded from performance aggregates. The initial fixed-32-KiB
pilot and adaptive pilot are also retained separately. See
[artifact locations and hashes](evidence/artifacts.json).

## Regression checks

```sh
bun test src
bun typecheck.ts
bun build.ts --test
bun integration.ts remote viewer_sync reloads --jobs 1
```

[Validation evidence](evidence/validation.json) records the exact candidate and
results. No wire version or saved-state format changes are needed: receipts
already exist and all learned state is ephemeral.

Generate the detailed tables after reducing all three RTT suites:

```sh
python3 tools/benchmarks/remote_network/throughput_tables.py /tmp/corgi-throughput-report
```

For per-product sleep summaries (keep before and after separate):

```sh
for label in before after herdr; do
  python3 tools/benchmarks/remote_network/summarize.py \
    /tmp/corgi-sleep/$label-* --output /tmp/corgi-throughput-report/sleep-$label.json
done
```

The local [performance archive](../../../../dist/remote-throughput-comparison.tar.gz)
and [diagnostic archive](../../../../dist/remote-throughput-diagnostics.tar.gz)
retain the complete observations. Their hashes are in [artifacts.json](evidence/artifacts.json);
the archives are local artifacts, while the compact evidence is checked in.
