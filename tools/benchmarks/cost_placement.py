#!/usr/bin/env python3
"""Prospective host-only L3 placement selection; launches no application workload."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import time

import corgi_costs
import cost_clamp


def candidates(nodes, observer):
    allowed = os.sched_getaffinity(0)
    found, skipped = [], []
    for node in nodes:
        remaining = corgi_costs.cpu_list(Path(f"/sys/devices/system/node/node{node}/cpulist").read_text()) & allowed
        while remaining:
            cpu = min(remaining)
            root = Path(f"/sys/devices/system/cpu/cpu{cpu}")
            cache = next(path for path in (root / "cache").glob("index*")
                         if (path / "level").read_text().strip() == "3")
            shared = corgi_costs.cpu_list((cache / "shared_cpu_list").read_text())
            remaining -= shared
            if observer in shared:
                skipped.append(dict(node=node, l3_shared=sorted(shared), reason="observer L3"))
                continue
            cores = {}
            for item in sorted(shared & allowed):
                base = Path(f"/sys/devices/system/cpu/cpu{item}/topology")
                key = ((base / "physical_package_id").read_text().strip(), (base / "core_id").read_text().strip())
                cores.setdefault(key, item)
            selected = sorted(cores.values())
            try:
                placement = corgi_costs.topology(",".join(map(str, selected)), node)
            except ValueError as error:
                skipped.append(dict(node=node, l3_shared=sorted(shared), reason=str(error)))
                continue
            placement["observer_cpu"] = observer
            found.append(placement)
    return found, skipped


def window(samples, cpus, tail_seconds=None):
    start = samples[0]
    if tail_seconds is not None:
        threshold = samples[-1]["monotonic"] - tail_seconds
        start = min(samples, key=lambda sample: abs(sample["monotonic"] - threshold))
    end = samples[-1]
    loads = corgi_costs.load_between(start["counters"], end["counters"], cpus)
    return dict(seconds=end["monotonic"] - start["monotonic"], per_cpu=loads,
                maximum=max(loads.values()), aggregate=sum(loads.values()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--nodes", default="0,1")
    parser.add_argument("--observer", type=int, default=0)
    parser.add_argument("--cpus", help="Verify this existing eight-core placement instead of selecting another group")
    args = parser.parse_args()
    if args.seconds < 30:
        parser.error("A placement pilot must last at least30 seconds")
    if args.observer not in os.sched_getaffinity(0):
        parser.error("Observer CPU is not allowed")
    nodes = sorted({int(value) for value in args.nodes.split(",")})
    placements, skipped = candidates(nodes, args.observer)
    if args.cpus:
        selected = corgi_costs.cpu_list(args.cpus)
        placements = [placement for placement in placements if set(placement["selected"]) == selected]
    if not placements:
        parser.error("No eligible eight-core L3 topology found")
    observed = set().union(*(set(p["selected"] + p["siblings"]) for p in placements))
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        parser.error("Output already exists; preserve every prospective pilot")
    source = Path(__file__).resolve().parent
    receipt = dict(schema="corgi-host-placement-v1", started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   requested_seconds=args.seconds, interval_seconds=0.5, observer_cpu=args.observer,
                   requested_cpus=args.cpus,
                   criteria={"window_mean_limit": 0.02, "windows": ["whole pilot", "final30 seconds"],
                             "includes": "each selected logical CPU and every SMT sibling",
                             "rank": "fixed placement selected before the pilot" if args.cpus else "lowest worst mean across both windows; then lowest whole aggregate; node/CPU tie-break",
                             "selection_before_application_runs": True},
                   source_sha256={name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                                  for name in ["cost_placement.py", "corgi_costs.py", "cost_clamp.py", "cost_host.py", "cost_calibration.py"]},
                   skipped=skipped, candidates=placements, samples=[], selection=None,
                   note="Host-only prospective placement evidence, not CPU normalization or permission to relabel old attempts")
    with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.sched_setaffinity(0, {args.observer})
        receipt["observer_clamps"] = cost_clamp.task(os.getpid())
        if not cost_clamp.natural(receipt["observer_clamps"]):
            raise RuntimeError("Placement observer must have natural utilization clamps")
        started = time.monotonic()
        while True:
            now = time.monotonic()
            counters = corgi_costs.cpu_counters()
            receipt["samples"].append(dict(time=time.time(), monotonic=now,
                                            counters={cpu: counters[cpu] for cpu in observed}))
            if now - started >= args.seconds:
                break
            time.sleep(min(0.5, max(0, started + args.seconds - time.monotonic())))
        for placement in placements:
            cpus = set(placement["selected"] + placement["siblings"])
            whole = window(receipt["samples"], cpus)
            tail = window(receipt["samples"], cpus, 30)
            intervals = [corgi_costs.load_between(a["counters"], b["counters"], cpus)
                         for a, b in zip(receipt["samples"], receipt["samples"][1:])]
            placement.update(whole=whole, final30=tail,
                             interval_peak=max(value for sample in intervals for value in sample.values()),
                             worst_mean=max(whole["maximum"], tail["maximum"]),
                             eligible=whole["maximum"] < 0.02 and tail["maximum"] < 0.02)
        eligible = sorted((p for p in placements if p["eligible"]),
                          key=lambda p: (p["worst_mean"], p["whole"]["aggregate"], p["node"], p["selected"]))
        if eligible:
            best = eligible[0]
            receipt["selection"] = dict(node=best["node"], cpus=best["cpus"], siblings=best["siblings"],
                                         l3_id=best["cores"][0]["l3_id"], worst_mean=best["worst_mean"])
        receipt["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt["status"] = "selected" if eligible else "no quiet candidate"
        output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"receipt": str(output), "status": receipt["status"], "selection": receipt["selection"]}))
    if not eligible:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
