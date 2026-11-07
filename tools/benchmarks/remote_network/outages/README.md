# Reproduce the outage investigation

The [short report](report.md) links the comparison and diagnosis. Prerequisites,
network topology, terminal observer and producer are in the
[original playbook](../README.md). Herdr remains the official, unmodified v0.9.5
Linux x86_64 binary. No live agents or model calls are involved.

## Exact revisions

- Updated remote branch: `455a941b` (`design/remote-attempt-2`).
- Before recovery changes: `1b41f5ad`, including the rebased prior fixes and the
  new input-receipt/backpressure regression fix.
- After recovery changes: `35cef14d`.

Build both in separate worktrees so native assets and build manifests remain
associated with their sources:

```sh
git worktree add --detach ../corgi-outage-before 1b41f5ad
git worktree add --detach ../corgi-outage-after 35cef14d
(cd ../corgi-outage-before && bun install --frozen-lockfile && bun build.ts)
(cd ../corgi-outage-after && bun install --frozen-lockfile && bun build.ts)
```

Build the report checkout too if its observer's native dependencies are absent.
The recorded manifests contain the source, native and binary hashes. The
harness's `corgi_commit` field identifies its checkout; `build.releaseCommit`
identifies the tested Corgi binary. The Herdr binary has no Corgi build manifest.

## Comparison

From the checkout containing the current harness:

```sh
python3 tools/benchmarks/remote_network/outages.py \
  ../corgi-outage-before/dist/corgi \
  ../corgi-outage-after/dist/corgi \
  /path/to/herdr-v0.9.5 \
  /tmp/corgi-outage-comparison

python3 tools/benchmarks/remote_network/outage_report.py \
  /tmp/corgi-outage-comparison /tmp/corgi-outage-report/evidence
```

The coordinator holds the shared benchmark lock. Each round runs three separate
labs concurrently on disjoint CPU sets, with a different lab for each binary.
It rotates `32-39;48-55;64-71` between the products across three rounds. Every
lab has its own network namespaces, daemons, viewer, private SSH keys and
workloads. Rotation balances CPU placement; all products still share one host.
Use `--cpu-sets '0-3;4-7;8-11'` to select three available disjoint sets.

For a smaller machine, run `run.py` sequentially with the same CPU set and a
unique output directory for each product/repeat:

```sh
python3 tools/benchmarks/remote_network/run.py corgi /path/to/corgi \
  /tmp/corgi-one-round --suite faults --repeats 1 --cpus 0-3 \
  --fault-cases blackhole3,blackhole15,blackhole35,blackhole60
```

Use `herdr` as the product for its binary. The audit above expects the default
coordinator layout and rotation; adapt that check when intentionally changing
the experiment. `--cases` and `--repeats` customize the coordinator.

Every trial uses 120 ms RTT and 100% packet loss in both directions for the
specified duration, then restores the link. Loss is external to both products,
on the isolated bridge ports; host interfaces, routes, firewall and SSH
configuration remain untouched. Whole-link loss also affects neighbour
discovery, so long outages can involve more than established TCP retransmission.

Four progress workloads run on each of three machines. The selected remote PTY
is 132 × 47; the same producer updates at 20 Hz. Recovery first requires a fresh
screen with consistent sequence markers, then a unique input echoed by the
remote workload. Independent input logs verify delivery and detect duplicates;
before/after process inventories verify workload survival. Input sent after
Corgi detects a stall is intentionally suppressed, while already-sent numbered
input can survive link resume. These are distinct from duplicate or missing
post-recovery inputs.

The 35-second case was added after traces showed that recovery depends on when
restoration falls within connection retries. Three trials are descriptive, not
a broad outage distribution or a statistical significance test. Results are
Linux network simulations, not physical laptop suspend, Wi-Fi roaming or an
Internet field study. The older full bandwidth/sleep report remains historical;
this comparison does not remeasure that entire matrix.

## Recovery traces

Performance trials disable telemetry. Run a separate diagnostic with the same
binary and harness:

```sh
python3 tools/benchmarks/remote_network/run.py corgi /path/to/corgi \
  /tmp/corgi-outage-trace --suite faults --repeats 1 --trace \
  --fault-cases blackhole35,blackhole60
```

`--trace` enables the existing recorder with a `remote.` prefix filter. Before
closing each viewer, the harness signals its private Corgi processes to flush.
It retains `telemetry/<machine>/<pid>-<thread>.json`, periodic `tcp.jsonl`, fault
events, SSH server logs, terminal captures and remote input receipts.

To collect the same diagnostics outside the lab, start the viewer with:

```sh
CORGI_TELEMETRY_DIR=/tmp/corgi-trace \
CORGI_TELEMETRY_TRACE=1 CORGI_TELEMETRY_FILTER=remote. /path/to/corgi
# From another terminal, flush the viewer's recorder:
kill -USR2 VIEWER_PID
```

The recorder's Chrome-trace-compatible `traceEvents` use epoch microseconds.
Match `remote.transport` child PIDs to `ss` socket records. `remote.rpc` durations
span request send through response/failure; event order in the file is completion
order, so sort by `ts` for a chronological start-time view. `remote.connection`
and `remote.race` show phase, generation, health age and budgets. These traces
record no terminal input bytes or request bodies. `CORGI_TELEMETRY_FILTER` only
filters the timeline; aggregate counters still run normally.

Earlier diagnostic pilots guided the implementation and are excluded from the
comparison. Their manifests and timelines identify which revision was under
test; a slower intermediate 60-second result was not pooled with final results.

## Validation

```sh
bun test src
bun typecheck.ts
bun build.ts --test
bun integration.ts remote viewer_sync reloads --jobs 1
```

The regression test `test_a_hung_reconnect_is_raced_without_waiting_for_the_ssh_timeout`
fails with the rebased pre-fix binary and passes after the recovery change.
It strands the first reconnect handshake, requires another connection before
30 seconds, and checks remote process continuity and exact-once output.
Unit tests additionally cover preserving a spare across a primary timeout,
cancelling it on pause, resuming the same link, and retaining input receipts
when the render window rejects their frame.

## Retained artifacts

- [Comparison archive](../../../../dist/remote-outage-comparison.tar.gz): all nine performance labs.
- [Control archive](../../../../dist/remote-outage-controls.tar.gz): final traces, startup and bandwidth/loss checks.
- [Pilot archive](../../../../dist/remote-outage-pilots.tar.gz): earlier diagnostics, excluded from comparison.
- [Checksums and sizes](evidence/artifacts.json); [pilot build manifests](evidence/diagnostics.json).

The archives remain local ignored files; curated summaries, evidence, tests and
playbooks are committed. To regenerate the joined diagnostic timeline:

```sh
python3 tools/benchmarks/remote_network/outage_timeline.py \
  /tmp/corgi-outage-trace /tmp/corgi-outage-report/evidence/after-timeline.json
```

The supplementary checks used the final binary, separately from the comparison:

```sh
python3 tools/benchmarks/remote_network/run.py corgi /path/to/corgi \
  /tmp/corgi-startup-check --suite startup --repeats 3 --rtts 300
python3 tools/benchmarks/remote_network/run.py corgi /path/to/corgi \
  /tmp/corgi-bandwidth-check --suite stream --repeats 1 \
  --stream-cases sparse:64kbit,sparse:256kbit,loss
```

They passed all six startup attempts and all 15 input probes. The stream checks
are one trial per profile: p95 held-screen ages were 0.59 s at 64 kbit/s, 0.12 s
at 256 kbit/s, and 0.26 s with loss/jitter. [Control data](evidence/controls.json).
