#!/usr/bin/env python3
"""Serial Corgi/Herdr comparison with a shared lock and explicit NUMA placement.

python3 tools/benchmarks/cost_matrix.py CORGI HERDR /tmp/fresh-costs
Build before running. No other benchmarks, tests, or builds during this command.
"""

import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
import random
from cost_host import frequencies, frequency_policy, population
import cost_clamp
import cost_calibration
import cost_blocks
import corgi_costs

cpu_accounting = "proc-stat-user-system-v1"

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cpu_list(value):
    cpus = set()
    for part in value.strip().split(","):
        bounds = list(map(int, part.split("-")))
        cpus.update(range(bounds[0], bounds[-1] + 1))
    return cpus


def cpu_counters():
    result = {}
    for line in Path("/proc/stat").read_text().splitlines():
        fields = line.split()
        if fields[0].startswith("cpu") and fields[0][3:].isdigit():
            values = list(map(int, fields[1:9]))
            result[int(fields[0][3:])] = (sum(values) - values[3] - values[4], sum(values))
    return result


def load_between(before, after, cpus):
    return {
        cpu: (after[cpu][0] - before[cpu][0]) / max(1, after[cpu][1] - before[cpu][1])
        for cpu in cpus
    }


def status(pid):
    try:
        fields = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines())
        return {
            "rss_kib": int(fields["VmRSS"].split()[0]),
            "high_water_kib": int(fields["VmHWM"].split()[0]),
            "cpus": fields["Cpus_allowed_list"].strip(),
            "mems": fields["Mems_allowed_list"].strip(),
        }
    except (FileNotFoundError, ProcessLookupError, KeyError):
        return None


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def native_maps(pid):
    try:
        paths = {line.split()[-1] for line in Path(f"/proc/{pid}/maps").read_text().splitlines()
                 if "/libcorgi_" in line}
        return {str(path): sha(Path(path)) for path in sorted(paths)}
    except (FileNotFoundError, ProcessLookupError):
        return {}


def thread_ticks(pid):
    values = {}
    try:
        for path in Path(f"/proc/{pid}/task").iterdir():
            try:
                raw = (path / "stat").read_text()
                fields = raw[raw.rfind(")") + 2:].split()
                values[path.name] = {"name": raw[raw.find("(") + 1:raw.rfind(")")],
                                     "ticks": int(fields[11]) + int(fields[12]), "cpu": int(fields[36]),
                                     "user_ticks": int(fields[11]), "system_ticks": int(fields[12])}
            except (FileNotFoundError, ProcessLookupError):
                pass
    except (FileNotFoundError, ProcessLookupError):
        pass
    return values



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corgi", type=Path)
    parser.add_argument("herdr", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--agents", type=int, default=16)
    parser.add_argument("--scenario", choices=["default", "warm-stream", "sparse"], default="default")
    parser.add_argument("--workload", choices=["all", "idle", "busy"], default="all", help="Fresh idle or busy agents, measured attached then detached")
    parser.add_argument("--stream-mode", choices=["scroll", "sparse"], help="Producer text shape, independent of phase selection")
    parser.add_argument("--seconds", type=float)
    parser.add_argument("--initial-warmup", type=float, default=20)
    parser.add_argument("--warmup", type=float)
    parser.add_argument("--pairs", type=int, choices=[1, 2], default=2)
    parser.add_argument("--node", type=int, choices=[0, 1], help="Run one placement only; node1 reverses the product order")
    parser.add_argument("--cpus", help="Explicit eight physical cores sharing one L3; requires --node")
    parser.add_argument("--placement-receipt", type=Path)
    parser.add_argument("--producer-phase", choices=["independent", "aligned", "staggered"], default="independent")
    parser.add_argument("--diagnostic-frequency", action="store_true", help="Prospective diagnostic-only frequency treatment for a two-trial pair")
    parser.add_argument("--noise-diagnostic", action="store_true", help="Record sibling-load failures without retrying; retain every workload and provenance guard")
    parser.add_argument("--match-geometry", action="store_true")
    parser.add_argument("--uclamp", action="store_true", help="Request min=max1024 only for benchmark descendants; use strict environment guards")
    parser.add_argument("--balanced-block", action="store_true", help="Four fresh ABBA/BAAB trials per placement, calibration, frequency diagnostic only")
    parser.add_argument("--seed", type=int, default=20261026, help="Fixed random seed for balanced block order")
    parser.add_argument("--single-corgi", action="store_true", help="One Corgi trial per placement, identical quality/noise guards; no paired-product claim")
    parser.add_argument("--order", choices=["corgi-first", "herdr-first"], help="Explicit prospective order for a two-trial pair; defaults to placement order")
    args = parser.parse_args()
    if (args.cpus or args.placement_receipt) and args.node is None:
        parser.error("Explicit CPUs or placement receipt require --node")
    if args.single_corgi and args.balanced_block:
        parser.error("--single-corgi and --balanced-block are mutually exclusive")
    if args.order and (args.single_corgi or args.balanced_block):
        parser.error("--order applies only to a two-trial pair")
    if args.workload != "all" and args.scenario != "default":
        parser.error("--workload requires --scenario default")
    stream = args.scenario != "default"
    stream_mode = args.stream_mode or ("sparse" if args.scenario == "sparse" else "scroll")
    args.seconds = args.seconds if args.seconds is not None else (60 if stream else 15)
    args.warmup = args.warmup if args.warmup is not None else (120 if stream else 5)
    strict_environment = args.uclamp or args.balanced_block
    sibling_limit = 0.02 if strict_environment else 0.10
    frequency_gate = args.uclamp and not (args.balanced_block or args.single_corgi or args.diagnostic_frequency)
    if min(args.agents, args.seconds) <= 0 or min(args.initial_warmup, args.warmup) < 0:
        parser.error("Counts/durations must be positive; warmups must be nonnegative")
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    binaries = {role: path.resolve() for role, path in [("corgi", args.corgi), ("herdr", args.herdr)]}
    placements = [("8-15", 0), ("72-79", 1)]
    placements = [placements[args.node]] if args.node is not None else placements[:args.pairs]
    if args.cpus:
        placements = [(args.cpus, args.node)]
    topology = [corgi_costs.topology(cpus, node) for cpus, node in placements]
    placements = [(item["cpus"], item["node"]) for item in topology]
    excluded = set().union(*(set(item["selected"] + item["siblings"]) for item in topology))
    observers = os.sched_getaffinity(0) - excluded
    if not observers:
        raise ValueError("No observer CPU remains outside application cores and siblings")
    rng = random.Random(args.seed)
    orders = {node: ['corgi'] if args.single_corgi else rng.choice([['corgi', 'herdr', 'herdr', 'corgi'], ['herdr', 'corgi', 'corgi', 'herdr']])
              if args.balanced_block else (['corgi', 'herdr'] if node == 0 else ['herdr', 'corgi']) for cpus, node in placements}
    if args.order:
        orders = {node: ["corgi", "herdr"] if args.order == "corgi-first" else ["herdr", "corgi"] for cpus, node in placements}
    for cpus, node in placements:
        if not cpu_list(cpus) <= os.sched_getaffinity(0):
            raise RuntimeError(f"CPUs {cpus} unavailable; edit placements for this host")
        node_cpus = cpu_list(Path(f"/sys/devices/system/node/node{node}/cpulist").read_text())
        if not cpu_list(cpus) <= node_cpus:
            raise RuntimeError(f"CPUs {cpus} do not belong to node {node}")
    manifest = {
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scenario": args.scenario,
        "workload": args.workload,
        "stream_mode": stream_mode,
        "initial_shells": 1,
        "attached_view": "one viewer, first agent pane focused",
        "producer_schedule": args.producer_phase,
        "diagnostic_frequency_requested": args.diagnostic_frequency,
        "measurement_protocol": "single-v4" if args.single_corgi else "balanced-v4" if args.balanced_block else "paired-v3",
        "cpu_accounting": cpu_accounting,
        "paired_product_comparison": not args.single_corgi,
        "random_seed": args.seed if args.balanced_block else None,
        "planned_orders": orders,
        "explicit_pair_order": args.order,
        "frequency_treatment": "diagnostic only: recent busy samples mix with cached policy fallback" if args.balanced_block or args.single_corgi or args.diagnostic_frequency else "legacy paired reported-frequency guard when clamped",
        "native_override": None,
        "limits": "Shared host; CPU is percent of one core; defaults retained, including Corgi animation/resources. Herdr has different chrome and no equivalent animation/resource service. Reported frequency is not effective execution cycles.",
        "uclamp": {"requested_min": 1024, "requested_max": 1024, "observer_unclamped": True, "snapshot_interval_seconds": 1} if args.uclamp else None,
        "sibling_mean_limit": sibling_limit,
        "noise_policy": "diagnostic" if args.noise_diagnostic else "strict",
        "paired_frequency_relative_difference_limit": 0.05 if frequency_gate else None,
        "calibration_drift_flag_threshold": 0.10 if args.balanced_block else None,
        "host": subprocess.check_output(["lscpu"], text=True),
        "agents": args.agents,
        "matched_geometry": args.match_geometry,
        "placements": topology,
        "seconds": args.seconds,
        "initial_warmup": args.initial_warmup,
        "warmup": args.warmup,
        "monitor_interval_seconds": 0.5,
        "binaries": {role: {"path": str(path), "sha256": sha(path), "build": read_json(Path(str(path) + ".build.json"))} for role, path in binaries.items()},
        "harnesses": {name: sha(root / "tools/benchmarks" / name) for name in ["cpu.ts", "cost_matrix_herdr.ts", "cost_matrix_geometry.ts", "cost_matrix.py", "viewer_progress.ts", "matrix_quality.ts", "cpu_lock.ts", "cpu_memory.ts", "cost_host.py", "cost_clamp.py", "cost_calibration.py", "cost_blocks.py", "corgi_costs.py", "streaming_fixture.ts", "streaming_provider.ts.fixture", "observation_costs_fixture.ts"]},
        "attempts": [],
        "status": "waiting for lock",
    }
    if args.placement_receipt:
        data = args.placement_receipt.read_bytes()
        prior = json.loads(data)
        if prior.get("schema") == "corgi-host-placement-v1":
            choice = prior.get("selection")
            if not choice or choice["node"] != args.node or cpu_list(choice["cpus"]) != set(topology[0]["selected"]):
                raise ValueError("Application placement differs from the frozen host-only selection")
        (output / "placement-receipt.json").write_bytes(data)
        manifest["placement_receipt"] = dict(path=str(args.placement_receipt.resolve()), sha256=hashlib.sha256(data).hexdigest())
    source_copy = output / "harness"
    source_copy.mkdir()
    for name in manifest["harnesses"]:
        (source_copy / name).write_bytes((root / "tools/benchmarks" / name).read_bytes())
    save(output / "comparison.json", manifest)
    with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stat = Path(f"/proc/{os.getpid()}/stat").read_text()
        born = stat[stat.rfind(")") + 2:].split()[19]
        env = dict(os.environ)
        for key in list(env):
            if key.startswith("CPU_") or key.startswith("CORGI_TELEMETRY") or key in ["CORGI_NATIVE_ROOT", "BUN_OPTIONS", "HERDR_RENDER_PROF"]:
                env.pop(key, None)
        env.update(CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{born}", CPU_MATRIX_ONLY="1",
                   CPU_AGENTS=str(args.agents), CPU_INITIAL_WARMUP_SECONDS=str(args.initial_warmup),
                   CPU_WARMUP_SECONDS=str(args.warmup), CPU_STREAM_PHASE=args.producer_phase, CPU_STREAM_MODE=stream_mode, CPU_MATRIX_WORKLOAD=args.workload)
        if stream:
            env["CPU_STREAM_ONLY"] = "1"
        if args.match_geometry:
            env["CPU_MATCH_GEOMETRY"] = "1"
        # Keep this low-frequency observer away from either benchmark placement.
        observer = min(observers)
        os.sched_setaffinity(0, {observer})
        manifest["observer_cpu"] = observer
        manifest["observer_clamps"] = cost_clamp.task(os.getpid()) if args.uclamp else None
        if args.uclamp and not cost_clamp.natural(manifest["observer_clamps"]):
            raise RuntimeError("The comparison observer must retain natural utilization clamps")
        manifest["status"] = "measuring"
        for cpus, node in placements:
            selected = cpu_list(cpus)
            siblings = set().union(*(cpu_list(Path(f"/sys/devices/system/cpu/cpu{cpu}/topology/thread_siblings_list").read_text()) for cpu in selected)) - selected
            order = orders[node]
            block_begin = len(manifest['attempts'])
            calibration_before = None
            if args.balanced_block:
                print(f'Starting node{node} calibration before block', flush=True)
                calibration_before = cost_calibration.run(selected, node, args.uclamp)
                save(output / f'node{node}-calibration-before.json', calibration_before)
                if not calibration_before['valid']:
                    manifest['status'] = 'calibration command failed'
                    save(output / 'comparison.json', manifest)
                    raise SystemExit(4)
            for position, role in enumerate(order, 1):
                for attempt in range(1, 4):
                    slot = f'-run{position}' if args.balanced_block else ''
                    name = f"{role}-node{node}{slot}-try{attempt}"
                    dest = output / name
                    dest.mkdir()
                    if sha(binaries[role]) != manifest["binaries"][role]["sha256"]:
                        raise RuntimeError(f"Binary changed: {role}")
                    for filename, digest in manifest["harnesses"].items():
                        if sha(root / "tools/benchmarks" / filename) != digest:
                            raise RuntimeError(f"Harness changed: {filename}")
                    harness = "cpu.ts" if role == "corgi" else "cost_matrix_herdr.ts"
                    command = ["numactl", "--all", f"--physcpubind={cpus}", f"--membind={node}", "bun", f"tools/benchmarks/{harness}", str(binaries[role]), str(dest), str(args.seconds)]
                    if args.uclamp:
                        command = ["uclampset", "-m", "1024", "-M", "1024", *command]
                    host_before = population()
                    policy_before = frequency_policy(selected | siblings)
                    before = previous = cpu_counters()
                    samples, loaded, executables = [], {}, {}
                    clamps = []
                    next_clamp_snapshot = 0
                    print(f"Starting {name}", flush=True)
                    with (output / f"{name}.log").open("w") as log:
                        proc = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
                        while proc.poll() is None:
                            now = time.time()
                            counters = cpu_counters()
                            runtime = read_json(dest / "runtime.json")
                            if args.uclamp and now >= next_clamp_snapshot:
                                roots = [proc.pid, *(runtime[c] for c in ['daemon', 'viewer'] if runtime.get(c))]
                                clamps.append(cost_clamp.snapshot(roots))
                                next_clamp_snapshot = now + 1
                            sample = {"time": now, "sibling_busy": load_between(previous, counters, siblings),
                                      "selected_busy": load_between(previous, counters, selected), "frequency_khz": frequencies(selected | siblings)}
                            for component in ["daemon", "viewer"]:
                                pid = runtime.get(component)
                                sample[component] = status(pid) if pid else None
                                sample[component + "_threads"] = thread_ticks(pid) if pid else {}
                                if pid and component not in executables:
                                    try:
                                        executables[component] = sha(Path(f"/proc/{pid}/exe"))
                                    except (FileNotFoundError, ProcessLookupError):
                                        pass
                                if role == "corgi" and pid and len(loaded.get(component, {})) < 2:
                                    loaded[component] = native_maps(pid)
                            samples.append(sample)
                            previous = counters
                            time.sleep(0.5)
                    after = cpu_counters()
                    host_after = population()
                    policy_after = frequency_policy(selected | siblings)
                    host_load = load_between(before, after, selected | siblings)
                    cleanup = read_json(dest / "cleanup.json")
                    receipt = read_json(dest / "results.json")
                    producers_verified, producer_source = corgi_costs.verify_producers(receipt, args.producer_phase, manifest.get("producer_source"), allow_idle=args.workload == "idle")
                    if producers_verified and "producer_source" not in manifest:
                        manifest["producer_source"] = producer_source
                    settings_verified = (receipt.get("agents") == args.agents and receipt.get("workload") == args.workload
                                         and receipt.get("stream_mode") == stream_mode and receipt.get("warmup") == args.warmup
                                         and receipt.get("initialWarmup") == args.initial_warmup
                                         and (role != "corgi" or (receipt.get("corgi_intensity") == 50 and receipt.get("resources") is True)))
                    results = receipt.get("results", [])
                    for row in results:
                        started = datetime.datetime.fromisoformat(row["started_at"].replace("Z", "+00:00")).timestamp()
                        during = [sample for sample in samples if started <= sample["time"] <= started + row["seconds"]]
                        for component in ["daemon", "viewer"]:
                            rss = [sample[component]["rss_kib"] for sample in during if sample[component]]
                            row[f"{component}_rss_median_kib"] = statistics.median(rss) if rss else None
                            row[f"{component}_rss_max_kib"] = max(rss) if rss else None
                        row["affinity_verified"] = bool(during) and all(
                            sample[component] is not None and cpu_list(sample[component]["cpus"]) == selected
                            for sample in during for component in ["daemon", "viewer"]
                            if component == "daemon" or row.get("viewer_cpu") is not None)
                        row["rss_samples"] = len(during)
                        row["selected_busy_weighted_observed_khz"] = cost_clamp.phase_frequency(during, selected)
                        if strict_environment:
                            durations = [(sample['time'] - previous['time'], sample) for previous, sample in zip(during, during[1:])]
                            total_duration = sum(delta for delta, sample in durations)
                            row['max_measured_sibling_busy'] = max((sum(delta * sample['sibling_busy'][cpu] for delta, sample in durations) / total_duration for cpu in siblings), default=0) if total_duration else None
                        if args.uclamp:
                            in_phase = [sample for sample in clamps if started <= sample['time'] <= started + row['seconds']]
                            required = [runtime[c] for c in ['daemon', 'viewer'] if runtime.get(c) and (c == 'daemon' or row.get('viewer_cpu') is not None)]
                            row['clamps_verified'] = bool(in_phase) and all(sample['verified'] and all(pid in sample['processes'] for pid in required) for sample in in_phase)
                            row['clamp_snapshots'] = len(in_phase)
                    record = {"name": name, "role": role, "node": node, "cpus": cpus, "siblings": sorted(siblings), "command": command, "exit_code": proc.returncode, "host_load": host_load, "max_sibling_busy": max((host_load[cpu] for cpu in siblings), default=0), "max_sibling_interval_busy": max((busy for sample in samples[1:] for busy in sample["sibling_busy"].values()), default=0), "clean": cleanup.get("clean", False), "results": results}
                    expected = {"streaming-agents-viewer"} if stream else {"idle-agents-viewer", "streaming-agents-viewer", "streaming-agents-detached", "idle-agents-detached"}
                    if args.workload == "idle":
                        expected = {"idle-agents-viewer", "idle-agents-detached"}
                    elif args.workload == "busy":
                        expected = {"streaming-agents-viewer", "streaming-agents-detached"}
                    record["complete"] = {row["name"] for row in results} == expected
                    idle_verified = all(isinstance(row.get("idle_quality"), dict) and row["idle_quality"].get("valid") is True
                                        for row in results if row["name"].startswith("idle-agents-"))
                    native_hash = manifest["binaries"][role]["build"].get("nativeSHA256")
                    native_receipt = corgi_costs.native_receipt(loaded, native_hash) if role == "corgi" else None
                    embedded = role == "herdr" or native_receipt["verified"]
                    executable_verified = all(executables.get(c) == manifest["binaries"][role]["sha256"] for c in ["daemon", "viewer"])
                    record.update(producers_verified=producers_verified, settings_verified=settings_verified, idle_verified=idle_verified, native_receipt=native_receipt, native_maps=loaded, embedded_native_verified=embedded, executable_sha256=executables, executable_verified=executable_verified)
                    record['affinity_verified'] = bool(results) and all(row.get('affinity_verified', False) for row in results)
                    record['clamps_verified'] = not args.uclamp or bool(results) and all(row.get('clamps_verified', False) for row in results)
                    record['measured_sibling_guard_passed'] = not strict_environment or bool(results) and all(row.get('max_measured_sibling_busy') is not None and row['max_measured_sibling_busy'] < sibling_limit for row in results)
                    record["quality_pass"] = producers_verified and settings_verified and idle_verified and record["affinity_verified"] and embedded and executable_verified and proc.returncode == 0 and record["clean"] and record["complete"] and record['clamps_verified']
                    record["strict_environment_pass"] = record['measured_sibling_guard_passed'] and (record["max_sibling_busy"] < sibling_limit if strict_environment else record["max_sibling_busy"] <= sibling_limit)
                    record["accepted"] = record["quality_pass"] and (record["strict_environment_pass"] or args.noise_diagnostic)
                    manifest["attempts"].append(record)
                    save(output / f"{name}-samples.json", samples)
                    save(dest / "host.json", {"command": command, "returncode": proc.returncode,
                         "cpu_accounting": cpu_accounting,
                         "selected": sorted(selected), "siblings": sorted(siblings), "load": host_load,
                         "population_before": host_before, "population_after": host_after,
                         "frequency_policy_before": policy_before, "frequency_policy_after": policy_after,
                         "uclamp": manifest['uclamp'], "clamp_snapshots": clamps,
                         "max_sibling_busy": record["max_sibling_busy"], "clock_ticks_per_second": os.sysconf("SC_CLK_TCK"), "samples": samples})
                    save(output / "comparison.json", manifest)
                    print(json.dumps({"finished": name, "accepted": record["accepted"], "quality_pass": record["quality_pass"], "strict_environment_pass": record["strict_environment_pass"], "sibling_busy": record["max_sibling_busy"], "results": [{"phase": row["name"], "daemon": row["daemon_cpu"], "viewer": row["viewer_cpu"]} for row in results]}), flush=True)
                    if not record["quality_pass"]:
                        manifest["status"] = "failed"
                        save(output / "comparison.json", manifest)
                        raise SystemExit(proc.returncode or 1)
                    if record["accepted"]:
                        break
                else:
                    manifest["status"] = "incomplete due to sibling load"
                    save(output / "comparison.json", manifest)
                    raise SystemExit(2)
            if args.balanced_block:
                print(f'Starting node{node} calibration after block', flush=True)
                calibration_after = cost_calibration.run(selected, node, args.uclamp)
                save(output / f'node{node}-calibration-after.json', calibration_after)
                calibration = cost_calibration.compare(calibration_before, calibration_after)
                manifest.setdefault('blocks', []).append(cost_blocks.summary(manifest['attempts'][block_begin:], node, order, calibration))
                save(output / 'comparison.json', manifest)
            if frequency_gate:
                manifest.setdefault('pair_eligibility', []).append(cost_clamp.pair_eligibility(manifest['attempts'], node, 0.05))
                save(output / 'comparison.json', manifest)
        manifest["status"] = "complete"
        if frequency_gate:
            manifest['causal_comparison_eligible'] = all(pair['eligible'] for pair in manifest['pair_eligibility'])
            if not manifest['causal_comparison_eligible']:
                manifest['status'] = 'complete with frequency mismatch'
        save(output / "comparison.json", manifest)
        print(f"Complete: {output / 'comparison.json'}", flush=True)
        if frequency_gate and not manifest['causal_comparison_eligible']:
            raise SystemExit(3)


if __name__ == "__main__":
    main()
