# Strict Corgi candidate comparisons

`corgi_compare.py` runs a fresh, balanced four-trial block between two immutable
Corgi production binaries. Both use the real `cpu.ts` observer with default
intensity 50 and resource sampling enabled. The shared `corgi_costs.py` engine
also serves the optional-feature attribution CLI. This is separate from
Corgi-versus-Herdr product comparisons.

The engine retains the observer5 measurement contract: 16 agents plus the shell,
matched 132×47 pane geometry, 120 seconds of streaming warmup, 60 seconds sampled,
20 Hz sparse/scrolling workloads, live pane and spinner quality checks, cleanup,
all-thread utilization clamps at 1024, whole-trial and measured-window sibling
means below 2%, and at most three predeclared attempts per order position.
Continuous SHA-256 calibration runs before and after the complete block, outside
application windows. Its drift is a flag, never a CPU correction. Frequency
samples remain diagnostic only. One block is one contrast; it does not produce
a confidence interval.

Choose placement prospectively from host-only observations, before examining
application results. `--cpus` must identify eight allowed logical CPUs on eight
distinct physical cores, all in `--node` and sharing one L3. Actual SMT siblings
come from sysfs. The observer is pinned outside those cores and siblings.
Topology, CPU placement and any `--placement-receipt` are recorded before trials;
process affinity and sampled last-running CPU IDs are verified during each CPU
window. `--order ABBA` is the default; `BAAB` supports a prospectively selected
reverse block. Changing placement does not rehabilitate old rejected trials.

The binaries' `.build.json` files must match their executable SHA-256 and declare
a production build with embedded native metadata. Both roles receive identical
executable and loaded-library checks. After each trial, the engine hashes the
four extracted native assets in build order, verifies their aggregate against
the binary metadata, and compares mapped DSO hashes. It preserves all executed
harness sources and hashes alongside each block. Missing or incorrect quality,
settings, provenance, clamps, affinity or cleanup fails immediately; only noise
rejection receives the predeclared retries.

Prepare a new frozen observer by copying observer5's dependency tree and overlaying
`corgi_costs.py` and `corgi_compare.py`. Leave old observer directories and results
unchanged. Use a new output directory for every block:

```sh
env -u CORGI_NATIVE_ROOT -u BUN_OPTIONS \
  python3 tools/benchmarks/corgi_compare.py \
  /absolute/dist/corgi-retained-v14 /absolute/dist/corgi-retained-v15 \
  /absolute/dist/v14-v15-sparse-block1 \
  --scenario sparse --node 1 --cpus 72-79 --order ABBA \
  --placement-receipt /absolute/dist/prior-host-only-placement.json
```

The CPU list above is an example, not a selected future placement. The prospective
host-only pilot determines the actual command. Initial source preparation has not
run this coordinator; syntax, topology rejection fixtures, native receipt checks
and a short same-binary correctness preflight must pass in a separately scheduled
slot before a measured block.

The original feature-attribution-v1 coordinator used by the incomplete V14
optional-feature block is preserved unchanged in
`dist/retained-v14-feature-attribution/harness/` and frozen observer6. The new
thin feature CLI declares `feature-attribution-v2`; no previous result is
reclassified or rerun by this refactor.

The host-only pilot command is:

```sh
python3 tools/benchmarks/cost_placement.py /absolute/dist/v15-placement-pilot.json --seconds 60
```

It enumerates eligible L3 groups on both NUMA nodes and excludes the observer's
L3. Selection requires every selected logical CPU and sibling to stay below 2%
mean busy time in both the full pilot and its final 30 seconds. Eligible groups
are ranked by their worst mean, then their aggregate mean and a deterministic
topology tie-break. Half-second peaks are retained diagnostically. A no-quiet-set
result selects nothing. The subsequent coordinator rejects a recognized pilot
receipt if its selected placement differs from the requested application CPUs.
This pilot also requires the exclusive benchmark slot and does not change any
host scheduler or frequency policy.
