#!/usr/bin/env python3
"""Serial real-ReadyLoop source comparison. Builds only benchmark wrapper DSOs."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("source_tree", type=Path, help="Frozen v12 TS/native dependency tree")
    parser.add_argument("observer", type=Path, help="Frozen cost_probe.py with all-thread clamp census")
    parser.add_argument("output", type=Path)
    parser.add_argument("--node", type=int, choices=[0, 1], default=0)
    parser.add_argument("--warmup", type=float, default=3)
    parser.add_argument("--seconds", type=float, default=10)
    parser.add_argument("--direct-callback", action="store_true",
                        help="Compare current batched socket with threadsafe JSCallback; pass identical source paths")
    args = parser.parse_args()
    if args.warmup < 0 or args.seconds <= 0:
        parser.error("Invalid duration")
    if args.direct_callback and sha(args.original) != sha(args.candidate):
        parser.error("Callback transport comparison requires identical native source bytes")
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source_tree = args.source_tree.resolve()
    cpus = "8-15" if args.node == 0 else "72-79"
    selected = set(range(8, 16)) if args.node == 0 else set(range(72, 80))
    marker = f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock"
    with open(marker, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stat = Path(f"/proc/{os.getpid()}/stat").read_text()
        born = stat[stat.rfind(")") + 2:].split()[19]
        env = dict(os.environ)
        for key in list(env):
            if key.startswith("CPU_") or key.startswith("CORGI_TELEMETRY") or key in ["CORGI_NATIVE_ROOT", "BUN_OPTIONS"]:
                env.pop(key, None)
        env.update(CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{born}",
                   CPU_PROBE_CPUS=cpus, CPU_PROBE_UCLAMP="1",
                   READINESS_WARMUP=str(args.warmup), READINESS_SECONDS=str(args.seconds))
        wrapper = output / "readiness_costs.c"
        shutil.copy2(root / "tools/benchmarks/readiness_costs.c", wrapper)
        sources = {}
        (output / "harness").mkdir()
        shutil.copy2(Path(__file__), output / "harness/readiness_costs.py")
        shutil.copy2(args.observer.resolve(), output / "harness/cost_probe.py")
        for name in ["readiness_costs.ts", "cpu_lock.ts"]:
            path = root / "tools/benchmarks" / name
            shutil.copy2(path, source_tree / "tools/benchmarks" / name)
            shutil.copy2(path, output / "harness" / name)
            sources[name] = sha(path)
        variants = {}
        compiler = root / "scripts/zig"
        for role, source in [("original", args.original), ("candidate", args.candidate)]:
            copied = output / f"readiness-{role}.c"
            shutil.copy2(source, copied)
            callback = args.direct_callback and role == "candidate"
            variants[role] = {"source": str(source.resolve()), "source_sha256": sha(copied),
                              "transport": "threadsafe_callback_idle_socket" if callback else "socket", "libraries": {}}
            for diagnostic in [False, True]:
                mode = "diagnostic" if diagnostic else "timing"
                library = output / f"{role}-{mode}.so"
                command = [str(compiler), "cc", "-O3", "-shared", "-fPIC", "-pthread", "-std=c11", "-Wall", "-Wextra", "-Werror",
                           f'-DREADINESS_SOURCE="{copied}"', *( ["-DREADINESS_COUNTS=1"] if diagnostic else []),
                           *( ["-DREADINESS_CALLBACK=1"] if callback else []), str(wrapper), "-o", str(library)]
                with (output / f"{role}-{mode}-build.log").open("w") as log:
                    subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
                variants[role]["libraries"][mode] = {"path": str(library), "sha256": sha(library), "command": command}
        manifest = {
            "started_epoch": time.time(), "node": args.node, "cpus": cpus,
            "compiler_version": subprocess.check_output([str(compiler), "version"], cwd=root, text=True).strip(),
            "variants": variants, "harness_sha256": sources,
            "wrapper_sha256": sha(wrapper), "coordinator_sha256": sha(Path(__file__)),
            "observer_sha256": sha(args.observer.resolve()), "direct_callback": args.direct_callback,
            "frozen_dependency_manifest": json.loads((source_tree / "component-manifest.json").read_text()),
            "warmup": args.warmup, "seconds": args.seconds,
            "quality": "Exact generated bytes and sequence, each lane19–21Hz; diagnostic max delivery latency250ms; all-thread clamps1024/1024; whole and timed-window SMT<2%; frequency diagnostic only",
            "limits": "Component comparison, no whole-daemon claim. Timed DSOs contain no counters. Diagnostics have relaxed counters and per-payload clocks and are excluded from CPU estimates.",
            "runs": [],
        }
        save(output / "comparison.json", manifest)
        if args.direct_callback:
            library = variants["candidate"]["libraries"]["timing"]["path"]
            command = ["numactl", "--all", f"--physcpubind={cpus}", f"--membind={args.node}",
                       "bun", "tools/benchmarks/readiness_costs.ts", library, "aligned", "--callback", "--verify-only"]
            with (output / "callback-verification.log").open("w") as log:
                completed = subprocess.run(command, cwd=source_tree, env=env, stdout=log, stderr=subprocess.STDOUT,
                                           timeout=15)
            if completed.returncode:
                manifest["failure"] = {"name": "callback-verification", "returncode": completed.returncode}
                save(output / "comparison.json", manifest)
                raise SystemExit(completed.returncode)
            verification = json.loads((output / "callback-verification.log").read_text())
            assert verification["verification"]["close_with_queued"] == 50
            manifest["callback_verification"] = verification
            save(output / "comparison.json", manifest)
            print("Callback ordering, stale-token, idle-Socket lifetime and close checks passed", flush=True)
        # Warmed independent processes, ABBA within each scenario; diagnostics separate.
        plan = [(scenario, role, False, index) for scenario in ["aligned", "staggered"]
                for index, role in enumerate(["original", "candidate", "candidate", "original"], 1)]
        plan += [(scenario, role, True, index) for scenario, roles in [("aligned", ["original", "candidate"]), ("staggered", ["candidate", "original"])]
                 for index, role in enumerate(roles, 1)]
        for scenario, role, diagnostic, index in plan:
            mode = "diagnostic" if diagnostic else "timing"
            name = f"{scenario}-{mode}-{index}-{role}"
            dest = output / name
            library = Path(variants[role]["libraries"][mode]["path"])
            assert sha(library) == variants[role]["libraries"][mode]["sha256"]
            assert sha(args.observer.resolve()) == manifest["observer_sha256"], "Observer changed during block"
            for filename, expected in sources.items():
                assert sha(source_tree / "tools/benchmarks" / filename) == expected, "Frozen harness changed during block"
            command = ["python3", str(args.observer.resolve()), str(dest), "--", "numactl", "--all", f"--physcpubind={cpus}",
                       f"--membind={args.node}", "bun", "tools/benchmarks/readiness_costs.ts", str(library), scenario,
                       *( ["--diagnostic"] if diagnostic else []),
                       *( ["--callback"] if args.direct_callback and role == "candidate" else [])]
            print("Starting " + name, flush=True)
            with (output / f"{name}-observer.log").open("w") as log:
                completed = subprocess.run(command, cwd=source_tree, env=env, stdout=log, stderr=subprocess.STDOUT)
            if completed.returncode:
                manifest["failure"] = {"name": name, "returncode": completed.returncode}
                save(output / "comparison.json", manifest)
                raise SystemExit(completed.returncode)
            result = json.loads((dest / "run.log").read_text())
            save(dest / "results.json", result)
            host = json.loads((dest / "host.json").read_text())
            start = result["phase_started_epoch_ms"] / 1000
            samples = [s for s in host["samples"] if start <= s["time"] <= start + result["seconds"]]
            deltas = [(b["time"] - a["time"], b) for a, b in zip(samples, samples[1:])]
            duration = sum(d for d, _ in deltas)
            siblings = host["siblings"]
            window_smt = max(sum(d * s["siblings"][str(cpu)] for d, s in deltas) / duration for cpu in siblings) if duration else None
            clamps = [s for s in host["clamp_snapshots"] if start <= s["time"] <= start + result["seconds"]]
            verified = bool(clamps) and all(s["verified"] for s in clamps)
            accepted = verified and host["max_sibling_busy"] < .02 and window_smt is not None and window_smt < .02
            row = {"name": name, "role": role, "scenario": scenario, "diagnostic": diagnostic,
                   "accepted": accepted, "whole_smt": host["max_sibling_busy"], "window_smt": window_smt,
                   "clamps_verified": verified, "result": result}
            manifest["runs"].append(row)
            save(output / "comparison.json", manifest)
            print(json.dumps({"finished": name, "accepted": accepted, "whole_smt": row["whole_smt"], "window_smt": window_smt,
                              "cpu": result["cpu"], "counts": result["counters"], "latency_us": result["latency_us"]}), flush=True)
        for scenario in ["aligned", "staggered"]:
            for diagnostic in [False, True]:
                rows = [r for r in manifest["runs"] if r["scenario"] == scenario and r["diagnostic"] == diagnostic]
                assert len({r["result"]["canonical_payload_sha256"] for r in rows}) == 1, "Cross-variant payload mismatch"
        summary = {}
        for scenario in ["aligned", "staggered"]:
            summary[scenario] = {}
            for role in variants:
                rows = [r["result"]["cpu"] for r in manifest["runs"] if r["accepted"] and not r["diagnostic"] and r["role"] == role and r["scenario"] == scenario]
                summary[scenario][role] = {"accepted_runs": len(rows), "cpu": {key: {"mean": statistics.mean(r[key] for r in rows), "range": [min(r[key] for r in rows), max(r[key] for r in rows)]} for key in rows[0]} if rows else {}}
        manifest["summary"] = summary
        manifest["status"] = "complete"
        save(output / "comparison.json", manifest)


if __name__ == "__main__":
    main()
