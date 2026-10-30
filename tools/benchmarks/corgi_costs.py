#!/usr/bin/env python3
"""Shared strict Corgi-only balanced-block coordinator; launch via a thin CLI."""

import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
import math
from dataclasses import dataclass
from cost_host import frequencies, frequency_policy, population
import cost_clamp
import cost_calibration

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



@dataclass(frozen=True)
class Variant:
    role: str
    binary: Path
    intensity: int = 50
    resources: bool = True


@dataclass(frozen=True)
class Plan:
    variants: tuple[Variant, Variant]
    protocol: str
    purpose: str
    limits: str
    harness: str
    entrypoint: str
    extra_harnesses: tuple[str, ...] = ()


def arguments(parser):
    parser.add_argument("--producer-phase", choices=["independent", "aligned", "staggered"], default="independent")
    parser.add_argument("--agents", type=int, default=16)
    parser.add_argument("--scenario", choices=["warm-stream", "sparse"], default="sparse")
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--warmup", type=float, default=120)
    parser.add_argument("--node", type=int, choices=[0, 1], default=0)
    parser.add_argument("--cpus", help="Eight distinct physical cores sharing the chosen NUMA node and one L3")
    parser.add_argument("--order", choices=["ABBA", "BAAB"], default="ABBA")
    parser.add_argument("--placement-receipt", type=Path, help="Optional prior host-only placement-selection receipt")


def topology(cpus, node):
    selected = cpu_list(cpus)
    allowed = os.sched_getaffinity(0)
    if len(selected) != 8 or not selected <= allowed:
        raise ValueError("Placement must contain exactly eight allowed logical CPUs")
    node_cpus = cpu_list(Path(f"/sys/devices/system/node/node{node}/cpulist").read_text())
    if not selected <= node_cpus:
        raise ValueError("Every selected CPU must belong to the requested NUMA node")
    cores, l3_sets, siblings, rows = set(), set(), set(), []
    for cpu in sorted(selected):
        root = Path(f"/sys/devices/system/cpu/cpu{cpu}")
        package = int((root / "topology/physical_package_id").read_text())
        core = int((root / "topology/core_id").read_text())
        core_threads = cpu_list((root / "topology/thread_siblings_list").read_text())
        caches = [entry for entry in (root / "cache").glob("index*")
                  if (entry / "level").read_text().strip() == "3"]
        if len(caches) != 1:
            raise ValueError(f"CPU {cpu} does not have exactly one discoverable L3")
        cache = caches[0]
        shared = tuple(sorted(cpu_list((cache / "shared_cpu_list").read_text())))
        cores.add((package, core))
        l3_sets.add(shared)
        siblings.update(core_threads - selected)
        rows.append(dict(cpu=cpu, package=package, core=core, siblings=sorted(core_threads),
                         l3_id=(cache / "id").read_text().strip(), l3_shared=list(shared)))
    if len(cores) != 8 or len(l3_sets) != 1:
        raise ValueError("Placement must use eight distinct physical cores sharing one L3")
    if not selected <= set(next(iter(l3_sets))):
        raise ValueError("L3 membership does not cover the selected CPUs")
    observers = allowed - selected - siblings
    if not observers:
        raise ValueError("No allowed observer CPU remains outside application cores and siblings")
    return dict(cpus=",".join(map(str, sorted(selected))), node=node, selected=sorted(selected),
                siblings=sorted(siblings), cores=rows, observer_cpu=min(observers),
                original_allowed=sorted(allowed))


def native_receipt(loaded, expected):
    result = {"expected": expected, "verified": False, "roots": {}}
    if not expected:
        return result
    for component in ["daemon", "viewer"]:
        maps = loaded.get(component, {})
        if len(maps) != 2:
            return result
        roots = {Path(path).parent.parent for path in maps}
        if len(roots) != 1:
            return result
        root = next(iter(roots))
        if root.name != expected or root.parent.name != f"corgi-native-{os.getuid()}":
            return result
        if str(root) not in result["roots"]:
            digest, files = hashlib.sha256(), {}
            try:
                for name in ["lib/libcorgi_term.so", "lib/libcorgi_system.so", "bin/pty-exec", "bin/corgi-hook"]:
                    data = (root / name).read_bytes()
                    digest.update(data)
                    files[name] = hashlib.sha256(data).hexdigest()
            except OSError:
                return result
            result["roots"][str(root)] = dict(aggregate=digest.hexdigest(), files=files)
        receipt = result["roots"][str(root)]
        if receipt["aggregate"] != expected:
            return result
        if any(receipt["files"].get(str(Path(path).relative_to(root))) != value for path, value in maps.items()):
            return result
    result["verified"] = True
    return result


def verify_producers(receipt, requested, reference, allow_idle=False):
    source = receipt.get("producer_source")
    valid = isinstance(source, dict) and all(isinstance(source.get(key), str) and len(source[key]) == 64
                                           for key in ["provider_sha256", "runtime_sha256"])
    valid = valid and receipt.get("producer_schedule") == requested
    if valid and reference is not None:
        valid = all(source[key] == reference.get(key) for key in ["provider_sha256", "runtime_sha256"])
    if requested != "independent":
        streams = [row for row in receipt.get("results", []) if row["name"].startswith("streaming-")]
        valid = valid and (bool(streams) or allow_idle) and all(isinstance(row.get("producer_phase"), dict)
                 and row["producer_phase"].get("valid") is True
                 and row["producer_phase"].get("schedule") == requested for row in streams)
    return bool(valid), source


def balanced_summary(attempts, node, order, calibration, roles):
    chosen = [attempt for attempt in attempts if attempt['node'] == node and attempt['accepted']]
    phases = {}
    for attempt in chosen:
        for row in attempt['results']:
            phase = phases.setdefault(row['name'], {})
            role = phase.setdefault(attempt['role'], {'daemon': [], 'viewer': [], 'total': []})
            role['daemon'].append(row['daemon_cpu'])
            role['viewer'].append(row['viewer_cpu'] or 0)
            role['total'].append(row['daemon_cpu'] + (row['viewer_cpu'] or 0))
    result = {}
    for name, phase in phases.items():
        metrics = {}
        for metric in ('daemon', 'viewer', 'total'):
            a, b = (phase.get(role, {}).get(metric, []) for role in roles)
            if len(a) != 2 or len(b) != 2:
                raise ValueError('A balanced block needs exactly two accepted fresh trials per variant')
            first, second = statistics.mean(a), statistics.mean(b)
            metrics[metric] = {
                roles[0]: dict(values=a, mean=first, range=[min(a), max(a)]),
                roles[1]: dict(values=b, mean=second, range=[min(b), max(b)]),
                'first_minus_second_cpu_percentage_points': first - second,
                'first_over_second_ratio': first / second if second else None,
                'log_ratio': math.log(first / second) if first and second else None,
            }
        result[name] = metrics
    return dict(node=node, order=order, roles=roles, attempts=[attempt['name'] for attempt in chosen],
                phases=result, calibration=calibration, frequency_treatment='diagnostic only',
                note='One block is one independent contrast. Report ranges; confidence intervals require repeated independent blocks.')


def run(args, plan):
    roles = [variant.role for variant in plan.variants]
    if len(roles) != 2 or len(set(roles)) != 2:
        raise ValueError("A comparison requires two distinct variant roles")
    args.initial_warmup = 20
    args.pairs = 1
    args.uclamp = args.balanced_block = args.match_geometry = True
    args.single_corgi = False
    args.seed = None
    stream = args.scenario != "default"
    args.seconds = args.seconds if args.seconds is not None else (60 if stream else 15)
    args.warmup = args.warmup if args.warmup is not None else (120 if stream else 5)
    strict_environment = args.uclamp or args.balanced_block
    sibling_limit = 0.02 if strict_environment else 0.10
    frequency_gate = args.uclamp and not (args.balanced_block or args.single_corgi)
    if min(args.agents, args.seconds) <= 0 or min(args.initial_warmup, args.warmup) < 0:
        raise ValueError("Counts/durations must be positive; warmups must be nonnegative")
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    binaries = {variant.role: variant.binary.resolve() for variant in plan.variants}
    placement = topology(args.cpus or ("8-15" if args.node == 0 else "72-79"), args.node)
    placements = [(placement["cpus"], args.node)]
    first, second = roles
    order = [first, second, second, first] if args.order == "ABBA" else [second, first, first, second]
    orders = {args.node: order}
    binary_metadata = {role: {"path": str(path), "sha256": sha(path),
                             "build": read_json(Path(str(path) + ".build.json"))}
                       for role, path in binaries.items()}
    for role, metadata in binary_metadata.items():
        build = metadata["build"]
        if build.get("sha256") != metadata["sha256"] or not build.get("nativeSHA256") or build.get("testBuild") is not False:
            raise ValueError(f"Immutable production binary metadata is missing or mismatched: {role}")
    harness_names = ["corgi_costs.py", plan.entrypoint, plan.harness, *plan.extra_harnesses,
                     "cost_matrix_geometry.ts", "viewer_progress.ts", "matrix_quality.ts", "cpu_lock.ts", "cpu_memory.ts",
                     "cost_host.py", "cost_clamp.py", "cost_calibration.py", "streaming_fixture.ts",
                     "streaming_provider.ts.fixture", "observation_costs_fixture.ts"]
    harness_hashes = {name: sha(root / "tools/benchmarks" / name) for name in harness_names}
    manifest = {
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scenario": args.scenario,
        "producer_schedule": args.producer_phase,
        "measurement_protocol": plan.protocol,
        "cpu_accounting": cpu_accounting,
        "paired_product_comparison": False,
        "purpose": plan.purpose,
        "feature_settings": {v.role: {"intensity": v.intensity, "resources": v.resources} for v in plan.variants},
        "random_seed": args.seed if args.balanced_block else None,
        "planned_orders": orders,
        "frequency_treatment": "diagnostic only: recent busy samples mix with cached policy fallback" if args.balanced_block or args.single_corgi else "legacy paired reported-frequency guard when clamped",
        "native_override": None,
        "limits": plan.limits,
        "uclamp": {"requested_min": 1024, "requested_max": 1024, "observer_unclamped": True, "snapshot_interval_seconds": 1} if args.uclamp else None,
        "sibling_mean_limit": sibling_limit,
        "paired_frequency_relative_difference_limit": 0.05 if frequency_gate else None,
        "calibration_drift_flag_threshold": 0.10 if args.balanced_block else None,
        "host": subprocess.check_output(["lscpu"], text=True),
        "agents": args.agents,
        "matched_geometry": args.match_geometry,
        "placements": [placement],
        "planned_order": args.order,
        "seconds": args.seconds,
        "initial_warmup": args.initial_warmup,
        "warmup": args.warmup,
        "monitor_interval_seconds": 0.5,
        "binaries": binary_metadata,
        "harnesses": harness_hashes,
        "attempts": [],
        "status": "waiting for lock",
    }
    source_copy = output / "harness"
    source_copy.mkdir()
    for name in harness_hashes:
        (source_copy / name).write_bytes((root / "tools/benchmarks" / name).read_bytes())
    if args.placement_receipt:
        data = args.placement_receipt.read_bytes()
        selection_receipt = json.loads(data)
        if selection_receipt.get("schema") == "corgi-host-placement-v1":
            choice = selection_receipt.get("selection")
            if not choice or choice["node"] != args.node or cpu_list(choice["cpus"]) != set(placement["selected"]):
                raise ValueError("Application placement differs from the frozen host-only selection")
        (output / "placement-receipt.json").write_bytes(data)
        manifest["placement_receipt"] = dict(path=str(args.placement_receipt.resolve()), sha256=hashlib.sha256(data).hexdigest())
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
                   CPU_WARMUP_SECONDS=str(args.warmup), CPU_STREAM_PHASE=args.producer_phase, CPU_STREAM_MODE="sparse" if args.scenario == "sparse" else "scroll")
        if stream:
            env["CPU_STREAM_ONLY"] = "1"
        if args.match_geometry:
            env["CPU_MATCH_GEOMETRY"] = "1"
        # Keep this low-frequency observer away from either benchmark placement.
        observer = placement["observer_cpu"]
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
                    harness = plan.harness
                    settings = manifest["feature_settings"][role]
                    env["CPU_CORGI_INTENSITY"] = str(settings["intensity"])
                    env["CPU_RESOURCES"] = "1" if settings["resources"] else "0"
                    for filename, digest in manifest["harnesses"].items():
                        if sha(root / "tools/benchmarks" / filename) != digest:
                            raise RuntimeError(f"Harness changed: {filename}")
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
                                if pid and len(loaded.get(component, {})) < 2:
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
                    settings = manifest["feature_settings"][role]
                    settings_verified = (receipt.get("corgi_intensity") == settings["intensity"]
                                         and receipt.get("resources") == settings["resources"])
                    producers_verified, producer_source = verify_producers(receipt, args.producer_phase, manifest.get("producer_source"))
                    if producers_verified and "producer_source" not in manifest:
                        manifest["producer_source"] = producer_source
                    results = receipt.get("results", [])
                    for row in results:
                        started = datetime.datetime.fromisoformat(row["started_at"].replace("Z", "+00:00")).timestamp()
                        during = [sample for sample in samples if started <= sample["time"] <= started + row["seconds"]]
                        for component in ["daemon", "viewer"]:
                            rss = [sample[component]["rss_kib"] for sample in during if sample[component]]
                            row[f"{component}_rss_median_kib"] = statistics.median(rss) if rss else None
                            row[f"{component}_rss_max_kib"] = max(rss) if rss else None
                        row["rss_samples"] = len(during)
                        row["affinity_verified"] = bool(during) and all(
                            sample[component] is not None
                            and cpu_list(sample[component]["cpus"]) == selected
                            and all(thread["cpu"] in selected for thread in sample[component + "_threads"].values())
                            for sample in during for component in ["daemon", "viewer"])
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
                    record["complete"] = {row["name"] for row in results} == expected
                    native_hash = manifest["binaries"][role]["build"].get("nativeSHA256")
                    native = native_receipt(loaded, native_hash)
                    embedded = native["verified"]
                    executable_verified = all(executables.get(c) == manifest["binaries"][role]["sha256"] for c in ["daemon", "viewer"])
                    record.update(producers_verified=producers_verified, settings_verified=settings_verified, native_maps=loaded, native_receipt=native, embedded_native_verified=embedded, executable_sha256=executables, executable_verified=executable_verified)
                    record['affinity_verified'] = bool(results) and all(row.get('affinity_verified', False) for row in results)
                    record['clamps_verified'] = not args.uclamp or bool(results) and all(row.get('clamps_verified', False) for row in results)
                    record['measured_sibling_guard_passed'] = not strict_environment or bool(results) and all(row.get('max_measured_sibling_busy') is not None and row['max_measured_sibling_busy'] < sibling_limit for row in results)
                    record["accepted"] = producers_verified and settings_verified and embedded and executable_verified and proc.returncode == 0 and record["clean"] and record["complete"] and record['affinity_verified'] and record['clamps_verified'] and record['measured_sibling_guard_passed'] and (record["max_sibling_busy"] < sibling_limit if strict_environment else record["max_sibling_busy"] <= sibling_limit)
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
                    print(json.dumps({"finished": name, "accepted": record["accepted"], "sibling_busy": record["max_sibling_busy"], "results": [{"phase": row["name"], "daemon": row["daemon_cpu"], "viewer": row["viewer_cpu"]} for row in results]}), flush=True)
                    if not producers_verified or not settings_verified or proc.returncode or not record["clean"] or not record["complete"] or not embedded or not executable_verified or not record['affinity_verified'] or not record['clamps_verified']:
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
                manifest.setdefault('blocks', []).append(balanced_summary(manifest['attempts'][block_begin:], node, order, calibration, roles))
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

