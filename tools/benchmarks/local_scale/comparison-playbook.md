# Reproduce the local WebSocket before/after comparison

Use the [artifact workflow](../ARTIFACTS.md) to create a cache run directory.
Replace historical `dist/local-comparison*` data paths below with paths under
that directory; binaries may remain in `dist`. Reports also belong in the cache.

Use the same machine and Bun release for both production builds. The measured
baseline is `6c9cafb3`, immediately before `8802db03` migrated persistent local
RPC to WebSockets. The after build is `a49dd498`, which includes rollback support.
Native code is identical between those revisions. Neither build is patched.

From this worktree, with `dist/corgi` built at `a49dd498`:

```sh
git diff --exit-code 6c9cafb3 a49dd498 -- native
git worktree add --detach ../corgi-local-before-ws 6c9cafb3
```

In the baseline worktree, install the locked dependencies (or link this
worktree's identical `node_modules`) and build with the same native artifacts:

```sh
bun build.ts --no-native \
  --native-root ../corgi-remote-network-eval/native/zig-out \
  --outfile ../corgi-remote-network-eval/dist/corgi-before-ws
```

Back in this worktree, finish builds and tests before measurement. Linux, Bun,
`taskset`, `ss`, and passwordless `sudo bpftrace` are required. Use fresh output
paths each time:

```sh
bun typecheck.ts
bun test ./src
python3 tools/benchmarks/cost_placement.py /tmp/local-comparison-placement.json --seconds 30
taskset -c 0 python3 tools/benchmarks/local_scale/calibrate.py dist/local-comparison-calibration
python3 tools/benchmarks/local_scale/compare.py dist/local-comparison \
  --before dist/corgi-before-ws --after dist/corgi \
  --placement /tmp/local-comparison-placement.json
python3 tools/benchmarks/local_scale/long_spammy.py dist/local-comparison
python3 tools/benchmarks/local_scale/compare_report.py dist/local-comparison \
  --calibration dist/local-comparison-calibration \
  --destination /tmp/local-comparison-report
```

If the placement pilot finds no candidate below 2%, it exits with a receipt
and no selection. `--allow-noisy-placement` explicitly allows the coordinator
to select the least-busy candidate from that receipt **before** measurements;
it retains the failed threshold and every window's noise flag. This run used
that option after the shared host's best candidate reached 2.31% busy. Do not
interpret tiny differences as transport effects on this host.

The coordinator checks production-build identity, Bun/native equality, and
frozen binary/harness hashes before every run. It runs serially under the CPU
benchmark lock. At each count the default order is **before, after, after,
before**, giving two observations of each build with reversed pair order.
Workload order rotates between pairs. The same eight physical cores, provider
output, pane sizes, resource polling, and animation settings apply to both.
`--pairs`, `--counts`, `--seconds`, `--bandwidth-seconds`, and `--warmup` control
the matrix; the published defaults are 2 pairs, 15-second CPU windows,
5-second bandwidth windows, and 5-second warmup per window.

CPU is measured **without tracing**, using each process’s user+system ticks
across all threads. Provider processes are excluded. Waited-child ticks are
retained separately because their charge can arrive after the work occurred. A separate adjacent bandwidth sample
counts actual successful AF_UNIX sends in the kernel. Socket peer inodes select
only traffic between the real viewer and daemon in both directions, excluding
other process-internal Unix traffic. The before viewer uses its original raw
stream; the after viewer uses uncompressed WebSockets. Common raw RPC only
controls workload setup outside the measured windows. Startup and HTTP upgrade
bytes are outside the steady-state measurements.

See the [original workload playbook](playbook.md#workload) for exact producer
rates, geometry, and limitations. Every output producer has timestamped write
receipts. Visible progress is checked during measurement, followed by a
separate presentation/catch-up check. CPU ticks, byte counters, process/socket
identities, terminal snapshots, and server diagnostics are retained. No model
calls are made; everything runs in disposable isolated homes.

The report uses the first valid window for each planned count, pair, build, and
scenario, including valid windows from attempts that later failed another
scenario. Extra valid retry windows are retained in `additional-trials.json.gz`.
It flags SMT sibling load above 2% and reports means, individual values, and paired differences; two
observations per build do not justify confidence intervals or precise claims
about tiny CPU changes. Any failed trial stops the coordinator and retains its
logs. Preserve it before a documented rerun; do not replace trials based on
unfavorable performance.

The publisher independently reconciles CPU ticks, raw socket counters, producer
writes, visible progress, identities, and the complete predeclared matrix before
producing a table. Its archive includes the measured harness, plan, logs, and
receipts. The earlier current-only results remain separate in `evidence/`.

If a workload-validity check fails, preserve the attempt and resume explicitly:

```sh
python3 tools/benchmarks/local_scale/resume_compare.py dist/local-comparison \
  --retry-reason 'Describe the validity failure and why the entire trial is being repeated'
```

This checks the original frozen input hashes, moves the failed directory into
`failures/`, records `continuations.json`, and repeats that whole trial before
continuing the original order. It never replaces completed trials. Subsequent
runs retain stopped fixture homes and copy final producer receipts into the
trial directory. Remove only those recorded private homes after investigating.
The comparison includes two retries: a baseline producer reported zero writes
in a five-second sample; a WebSocket run later had overlapping 0.59–0.63 second
PTY-write stalls across all 32 producers while detached. Neither cause was
established. The latter run's earlier valid 275.7 kB/s attached sample remains
in the main results.

The initial plan excluded entire aborted attempts. After the second failure,
`analysis-policy.json` explicitly amended that rule to first-valid windows,
so a later failure could not hide the earlier bandwidth outlier. This rule is
applied to both builds and every scenario. Retries fill missing/invalid cases;
the publisher retains every other valid retry window as supplementary data.

The targeted `long_spammy.py` follow-up runs one 32-agent all-spammy sample per
build, before then after, with a 20-second untraced CPU window and separate
60-second byte-count window. It uses the same frozen inputs and CPU placement.
Its results are reported separately rather than replacing the original outlier.
