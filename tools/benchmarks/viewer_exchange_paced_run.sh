#!/usr/bin/env bash
# Run only after the exclusive CPU slot is granted. No native/product builds.
set -euo pipefail
experiment_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$experiment_root"
output=${1:?usage: bash tools/benchmarks/viewer_exchange_paced_run.sh NEW_OUTPUT_DIRECTORY}
fixture=dist/viewer-exchange-v15/plain.json
test -f "$fixture"
mkdir "$output"
mkdir -p "$output/preflight" "$output/timed/sources"

bun -e 'import {packages} from "./scripts/tooling";
const [path]=await packages("format",{prettier:"3.9.9"});
const child=Bun.spawn([process.execPath,path+"/bin/prettier.cjs","--write","tools/benchmarks/viewer_exchange_costs.ts"],{stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);' > "$output/format.log" 2>&1
bun -e 'import {packages} from "./scripts/tooling";
const [path]=await packages("typecheck",{typescript:"6.0.3"});
const child=Bun.spawn([process.execPath,path+"/bin/tsc","--ignoreConfig","--noEmit","--target","ESNext","--module","Preserve","--moduleResolution","Bundler","--strict","--skipLibCheck","--types","bun-types,node","--typeRoots",".tools/typecheck/types","tools/benchmarks/viewer_exchange_costs.ts","src/assets.d.ts"],{stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);' > "$output/typecheck.log" 2>&1

cp tools/benchmarks/viewer_exchange_costs.ts tools/benchmarks/cpu_lock.ts \
  tools/benchmarks/viewer_exchange_paced_run.sh "$output/timed/sources/"
cat > "$output/timed/plan.json" <<'JSON'
{
  "order": ["pull", "paced", "paced", "pull"],
  "warmup_seconds": 120, "sample_seconds": 30, "producer_hz": 20,
  "heartbeat_ms": 16, "phase_ms": 0,
  "cpus": [40,41,42,43,44,45,46,47], "siblings": [168,169,170,171,172,173,174,175],
  "numa_node": 0, "uclamp_min": 1024, "uclamp_max": 1024,
  "max_whole_invocation_sibling_busy": 0.02,
  "all_timed_clamps_required": true, "retries": 0,
  "scope": "Same JSON and receipt work; daemon retains 2/8/33 ms pacing. Passive settled 20 Hz only. No capture/rendering or production protocol."
}
JSON

numactl --all --physcpubind=40-47 --membind=0 timeout 30s \
  bun tools/benchmarks/viewer_exchange_costs.ts --paced-push --verify-only \
  --fixture "$fixture" --out "$output/preflight" > "$output/preflight.log" 2>&1

CPU_PROBE_CPUS=40-47 CPU_PROBE_UCLAMP=1 \
  python3 tools/benchmarks/cost_probe.py "$output/timed" -- \
  numactl --all --physcpubind=40-47 --membind=0 \
  bun tools/benchmarks/viewer_exchange_costs.ts --paced-push \
  --fixture "$fixture" --out "$output/timed" \
  --warmup 120 --seconds 30 --heartbeat 16 --phase 0

# cost_probe records noise/clamps; acceptance is assessed from those artifacts,
# not from this script's exit code. No automatic retries or extra variants.
