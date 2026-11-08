# Reproduce the fixes and follow-up comparison

Use the [original playbook](../README.md) for prerequisites, topology, workload
definitions and the pinned unmodified Herdr binary. Network measurements pin
`691fc36bb98147555325eeea4241bc2dbe569d9b`. The branch also includes the later
pane-exit cleanup fix `59a7fa4c`, with separate regression validation. Its full
performance matrix was not rerun. [Exact measured build](evidence/corgi-build.json).

Run the current harness against a build of the measured commit:

```sh
# In the checkout containing this report, build the observer's dependencies.
bun install --frozen-lockfile
bun build.ts
git worktree add --detach ../corgi-network-repro 691fc36b
(cd ../corgi-network-repro && bun install --frozen-lockfile && bun build.ts)

# Choose a new output path. This run takes roughly half an hour on the test host.
python3 tools/benchmarks/remote_network/candidate.py \
  ../corgi-network-repro/dist/corgi /tmp/cne-candidate-repeat \
  --herdr /path/to/herdr-v0.9.5

mkdir -p /tmp/cne-candidate-report/evidence
python3 tools/benchmarks/remote_network/summarize.py \
  /tmp/cne-candidate-repeat --output /tmp/cne-candidate-report/evidence/summary.json
python3 tools/benchmarks/remote_network/audit_candidate.py \
  /tmp/cne-candidate-repeat /tmp/cne-candidate-report/evidence/summary.json \
  /tmp/cne-candidate-report/evidence/audit.json
python3 tools/benchmarks/remote_network/tables.py \
  /tmp/cne-candidate-report/evidence/summary.json /tmp/cne-candidate-report \
  --note 'Corgi uses three trials; Herdr is a one-round control with the corrected producer.'
```

The coordinator acquires the shared benchmark lock and runs three independent
environments per startup, outage and bandwidth suite. The main matrix uses CPUs
32–39, as in the original comparison. The 180- and 660-second freezes overlap it
on CPUs 48–55 and 64–71 respectively, each with its own network namespaces,
daemons and workloads. Their remote workloads continue while their clients are
stopped. Herdr's additional bandwidth control runs after the candidate matrix
on CPUs 32–39. It uses the corrected producer and the unchanged official binary.

Use `--cpus`, `--sleep-cpus` and `--sleep-seconds` to select available CPUs and
durations. For a smaller host, use `--sleep-seconds ''` and run the two sleeps
sequentially with `run.py --suite sleep --sleep-seconds 180` and `660`; provide
the same product, binary, unique output directory and `--cpus` arguments as in
the original playbook. `audit_candidate.py` expects the full default matrix,
including both freezes and the Herdr control.

Rebuild the checked-in short comparison from its retained summaries with:

```sh
python3 tools/benchmarks/remote_network/compare_candidate.py \
  tools/benchmarks/remote_network/evidence/summary.json \
  tools/benchmarks/remote_network/followup/evidence/summary.json \
  tools/benchmarks/remote_network/followup/report.md
```

Validation commands:

```sh
bun test src
bun typecheck.ts
bun build.ts --test
bun integration.ts remote viewer_sync reloads --jobs 1
```

The remote integration suite checks real SSH, high latency, stalled-machine
navigation, interrupted input, instant typing and live reload. The unit tests
also cover default full-frame compatibility, bounded outstanding frames,
delta reconstruction before coalescing, stale generations and handoff resets.

Candidate and control measurements retain per-case producer liveness. An early
uncompressed pilot's dense trial lost its producer because PTY stdin/stdout
shared a nonblocking file description; it is excluded from final measurements.
The corrected producer completes blocking writes. It emits identical text at
the same nominal 20 Hz. No original raw ANSI recording contains that traceback.
The [diagnostic manifest](evidence/diagnostics.json) identifies the preliminary
runs, which are excluded from the final estimates.
The original comparison remains [available unchanged](../report.md), apart
from its link to this follow-up.
