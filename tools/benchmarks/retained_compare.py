#!/usr/bin/env python3
"""Serial Corgi baseline/candidate comparison; each binary uses its embedded native files.

python3 tools/benchmarks/retained_compare.py BASELINE CANDIDATE OUTPUT
Use --scenario warm-stream or sparse for a 120s warmup / 60s streaming window.
Builds, tests and other benchmarks must wait until this command releases its lock.
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
from cost_matrix import cpu_counters, cpu_list, load_between, read_json, save, sha, status


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
                                     "ticks": int(fields[11]) + int(fields[12])}
            except (FileNotFoundError, ProcessLookupError):
                pass
    except (FileNotFoundError, ProcessLookupError):
        pass
    return values


def summarize(manifest):
    accepted = [row for row in manifest["attempts"] if row["accepted"]]
    phases = {}
    for attempt in accepted:
        for row in attempt["results"]:
            phases.setdefault(row["name"], {}).setdefault(attempt["role"], []).append(row)
    summary = []
    for name, roles in phases.items():
        if set(roles) != {"baseline", "candidate"}:
            continue
        values = {}
        for role, rows in roles.items():
            totals = [row["daemon_cpu"] + (row["viewer_cpu"] or 0) for row in rows]
            viewers = [row["viewer_cpu"] for row in rows if row["viewer_cpu"] is not None]
            values[role] = {
                "total_cpu_mean": statistics.mean(totals), "total_cpu_range": [min(totals), max(totals)],
                "daemon_cpu_mean": statistics.mean(row["daemon_cpu"] for row in rows),
                "viewer_cpu_mean": statistics.mean(viewers) if viewers else None,
                "terminal_bytes_per_second": statistics.mean(row["viewer_bytes_per_second"] for row in rows),
                "trials": len(rows),
            }
            for component in ["daemon", "viewer"]:
                rss = [row[f"{component}_rss_median_kib"] for row in rows if row[f"{component}_rss_median_kib"] is not None]
                values[role][f"{component}_rss_mean_mib"] = statistics.mean(rss) / 1024 if rss else None
            progress = [row["streaming_progress"]["visible_lines_per_second"] for row in rows if row["streaming_progress"]]
            cadence = [row["streaming_quality"]["visible_changes_per_second"] for row in rows if row["streaming_quality"]]
            gaps = [row["streaming_quality"]["max_observed_gap_ms"] for row in rows if row["streaming_quality"]]
            values[role]["visible_lines_per_second"] = statistics.mean(progress) if progress else None
            values[role]["visible_changes_per_second"] = statistics.mean(cadence) if cadence else None
            values[role]["max_observed_gap_ms"] = max(gaps) if gaps else None
            animation = [row["streaming_quality"]["animation"] for row in rows if row["streaming_quality"]]
            values[role]["ui_animation_changes_per_second"] = statistics.mean(a["visible_changes_per_second"] for a in animation) if animation else None
            values[role]["ui_animation_max_gap_ms"] = max((a["max_observed_gap_ms"] for a in animation), default=None)
            values[role]["ui_animation_minimum_visible_spinners"] = min((a["minimum_visible_spinners"] for a in animation), default=None)
        left, right = values["baseline"], values["candidate"]
        values["total_cpu_reduction_percent"] = 100 * (1 - right["total_cpu_mean"] / left["total_cpu_mean"])
        values["byte_guard_passed"] = right["terminal_bytes_per_second"] <= max(
            left["terminal_bytes_per_second"] * 1.25, left["terminal_bytes_per_second"] + 200)
        values["cadence_guard_passed"] = all(left[key] is None or (right[key] is not None and right[key] >= .95 * left[key])
                                               for key in ["visible_lines_per_second", "visible_changes_per_second", "ui_animation_changes_per_second"])
        summary.append({"phase": name, **values})
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--scenario", choices=["default", "warm-stream", "sparse"], default="default")
    parser.add_argument("--pairs", type=int, choices=[1, 2], default=2)
    parser.add_argument("--agents", type=int, default=16)
    parser.add_argument("--seconds", type=float)
    parser.add_argument("--warmup", type=float)
    parser.add_argument("--initial-warmup", type=float, default=30)
    parser.add_argument("--match-geometry", action="store_true")
    parser.add_argument("--resume", action="store_true", help="Resume accepted trials after verifying unchanged binaries and fixture harnesses")
    args = parser.parse_args()
    stream = args.scenario != "default"
    seconds = args.seconds if args.seconds is not None else (60 if stream else 20)
    warmup = args.warmup if args.warmup is not None else (120 if stream else 15)
    if min(seconds, args.agents) <= 0 or min(warmup, args.initial_warmup) < 0:
        parser.error("Positive sample/count and nonnegative warmups required")
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=args.resume)
    binaries = {role: getattr(args, role).resolve() for role in ["baseline", "candidate"]}
    placements = [("8-15", 0), ("72-79", 1)][:args.pairs]
    for cpus, node in placements:
        if not cpu_list(cpus) <= os.sched_getaffinity(0):
            raise RuntimeError(f"Placement {cpus} unavailable")
        if not cpu_list(cpus) <= cpu_list(Path(f"/sys/devices/system/node/node{node}/cpulist").read_text()):
            raise RuntimeError(f"Placement {cpus} not on node {node}")
    manifest = {
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scenario": args.scenario, "agents": args.agents, "seconds": seconds,
        "warmup": warmup, "initial_warmup": args.initial_warmup,
        "matched_geometry": args.match_geometry, "native_override": None,
        "host": subprocess.check_output(["lscpu"], text=True),
        "binaries": {role: {"path": str(path), "sha256": sha(path),
                            "build": read_json(Path(str(path) + ".build.json"))} for role, path in binaries.items()},
        "harnesses": {name: sha(root / "tools/benchmarks" / name) for name in
                      ["retained_compare.py", "cpu.ts", "viewer_progress.ts", "cpu_lock.ts"]},
        "attempts": [], "status": "waiting for lock",
        "limits": "Shared host; sibling average guard 10%, interval bursts retained. CPU=one core; RSS is not allocation traffic.",
    }
    current_harnesses = manifest["harnesses"]
    if args.resume:
        previous = read_json(output / "comparison.json")
        for key in ["scenario", "agents", "seconds", "warmup", "initial_warmup", "matched_geometry", "binaries"]:
            if previous.get(key) != manifest[key]:
                raise RuntimeError(f"Cannot resume: {key} changed")
        for name, digest in current_harnesses.items():
            if name != "retained_compare.py" and previous.get("harnesses", {}).get(name) != digest:
                raise RuntimeError(f"Cannot resume: fixture harness {name} changed")
        previous.setdefault("resumptions", []).append({"at": manifest["started_at"], "harnesses": current_harnesses})
        manifest = previous
    save(output / "comparison.json", manifest)
    with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw = Path(f"/proc/{os.getpid()}/stat").read_text()
        born = raw[raw.rfind(")") + 2:].split()[19]
        env = dict(os.environ)
        for key in list(env):
            if key.startswith("CPU_") or key.startswith("CORGI_TELEMETRY") or key in ["CORGI_NATIVE_ROOT", "BUN_OPTIONS"]:
                env.pop(key, None)
        env.update(CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{born}", CPU_MATRIX_ONLY="1",
                   CPU_AGENTS=str(args.agents), CPU_INITIAL_WARMUP_SECONDS=str(args.initial_warmup),
                   CPU_WARMUP_SECONDS=str(warmup), CPU_STREAM_MODE="sparse" if args.scenario == "sparse" else "scroll")
        if stream:
            env["CPU_STREAM_ONLY"] = "1"
        if args.match_geometry:
            env["CPU_MATCH_GEOMETRY"] = "1"
        excluded = set()
        for cpus, _ in placements:
            for cpu in cpu_list(cpus):
                excluded |= cpu_list(Path(f"/sys/devices/system/cpu/cpu{cpu}/topology/thread_siblings_list").read_text())
        observer = min(os.sched_getaffinity(0) - excluded)
        os.sched_setaffinity(0, {observer})
        manifest.update(observer_cpu=observer, status="measuring")
        for pair, (cpus, node) in enumerate(placements):
            selected = cpu_list(cpus)
            siblings = set().union(*(cpu_list(Path(f"/sys/devices/system/cpu/cpu{cpu}/topology/thread_siblings_list").read_text()) for cpu in selected)) - selected
            for role in (["baseline", "candidate"] if pair == 0 else ["candidate", "baseline"]):
                prior = [a for a in manifest["attempts"] if a["role"] == role and a["node"] == node]
                if any(a["accepted"] for a in prior):
                    print(f"Keeping accepted {role}-node{node}", flush=True)
                    continue
                first_attempt = 1 + max((int(a["name"].rsplit("try", 1)[1]) for a in prior), default=0)
                for attempt in range(first_attempt, first_attempt + 3):
                    name = f"{role}-node{node}-try{attempt}"
                    dest = output / name
                    if sha(binaries[role]) != manifest["binaries"][role]["sha256"]:
                        raise RuntimeError(f"Binary changed: {role}")
                    dest.mkdir()
                    command = ["numactl", "--all", f"--physcpubind={cpus}", f"--membind={node}", "bun",
                               "tools/benchmarks/cpu.ts", str(binaries[role]), str(dest), str(seconds)]
                    before = previous = cpu_counters()
                    samples, loaded = [], {}
                    print(f"Starting {name} ({args.scenario})", flush=True)
                    with (output / f"{name}.log").open("w") as log:
                        child = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
                        while child.poll() is None:
                            counters = cpu_counters()
                            runtime = read_json(dest / "runtime.json")
                            sample = {"time": time.time(), "sibling_busy": load_between(previous, counters, siblings)}
                            for component in ["daemon", "viewer"]:
                                pid = runtime.get(component)
                                sample[component] = status(pid) if pid else None
                                sample[component + "_threads"] = thread_ticks(pid) if pid else {}
                                if pid and len(loaded.get(component, {})) < 2:
                                    loaded[component] = native_maps(pid)
                            samples.append(sample)
                            previous = counters
                            time.sleep(0.5)
                    host_load = load_between(before, cpu_counters(), selected | siblings)
                    results = read_json(dest / "results.json").get("results", [])
                    for row in results:
                        start = datetime.datetime.fromisoformat(row["started_at"].replace("Z", "+00:00")).timestamp()
                        during = [s for s in samples if start <= s["time"] <= start + row["seconds"]]
                        for component in ["daemon", "viewer"]:
                            rss = [s[component]["rss_kib"] for s in during if s[component]]
                            row[f"{component}_rss_median_kib"] = statistics.median(rss) if rss else None
                    expected = {"streaming-agents-viewer"} if stream else {
                        "idle-agents-viewer", "streaming-agents-viewer", "streaming-agents-detached", "idle-agents-detached"}
                    native_hash = manifest["binaries"][role]["build"].get("nativeSHA256")
                    embedded = bool(native_hash) and all(len(loaded.get(c, {})) == 2 and all(
                        f"/corgi-native-{os.getuid()}/{native_hash}/" in path for path in loaded[c])
                        for c in ["daemon", "viewer"])
                    record = {"name": name, "role": role, "node": node, "command": command,
                              "harnesses": current_harnesses,
                              "returncode": child.returncode, "native_maps": loaded, "embedded_native_verified": embedded,
                              "max_sibling_busy": max(host_load[c] for c in siblings),
                              "max_sibling_interval_busy": max((v for s in samples[1:] for v in s["sibling_busy"].values()), default=0),
                              "clean": read_json(dest / "cleanup.json").get("clean", False),
                              "complete": {r["name"] for r in results} == expected, "results": results}
                    record["accepted"] = child.returncode == 0 and record["clean"] and record["complete"] and embedded and record["max_sibling_busy"] <= .10
                    manifest["attempts"].append(record)
                    manifest["summary"] = summarize(manifest)
                    save(output / f"{name}-samples.json", samples)
                    save(dest / "host.json", {"command": command, "returncode": child.returncode,
                                              "selected": sorted(selected), "siblings": sorted(siblings),
                                              "load": host_load, "max_sibling_busy": record["max_sibling_busy"],
                                              "clock_ticks_per_second": os.sysconf("SC_CLK_TCK"), "samples": samples})
                    save(output / "comparison.json", manifest)
                    print(json.dumps({"finished": name, "accepted": record["accepted"], "native_verified": embedded,
                                      "sibling_busy": record["max_sibling_busy"], "results": [
                                          {"phase": row["name"], "daemon": row["daemon_cpu"], "viewer": row["viewer_cpu"],
                                           "bytes_per_second": row["viewer_bytes_per_second"]} for row in results]}), flush=True)
                    if child.returncode or not record["clean"] or not record["complete"] or not embedded:
                        manifest["status"] = "failed"
                        save(output / "comparison.json", manifest)
                        raise SystemExit(child.returncode or 1)
                    if record["accepted"]:
                        break
                else:
                    raise SystemExit("All attempts rejected by sibling-load guard")
        manifest["status"] = "complete" if all(r["byte_guard_passed"] and r["cadence_guard_passed"] for r in manifest["summary"]) else "output quality regression"
        save(output / "comparison.json", manifest)
        print(json.dumps(manifest["summary"], indent=2))
        if manifest["status"] != "complete":
            raise SystemExit(3)


if __name__ == "__main__":
    main()
