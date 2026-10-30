#!/usr/bin/env python3
"""Summarize existing cost_probe samples; this does not launch a benchmark."""
import argparse
from collections import defaultdict
from datetime import datetime
import json
import os
from pathlib import Path


def group(name, tid, pid):
    if tid == str(pid):
        return "main"
    return {
        "JITWorker": "jit",
        "HeapHelper": "heap_helper",
        "mi-scavenger": "scavenger",
        "corgi-fd-ready": "fd_ready",
        "corgi-pty-read": "pty_reader",
        "Worker": "worker",
        "JSCWarmUp": "warmup",
    }.get(name, "other")


def has_split(value):
    return "user_ticks" in value and "system_ticks" in value


def window(samples, start, end, role, pid, hz):
    selected = [sample for sample in samples if start <= sample["time"] <= end]
    if len(selected) < 2:
        return None
    first, last = selected[0], selected[-1]
    before, after = first[role + "_threads"], last[role + "_threads"]
    elapsed = last["time"] - first["time"]
    groups = defaultdict(float)
    user_groups, system_groups = defaultdict(float), defaultdict(float)
    shared = before.keys() & after.keys()
    split_complete = bool(shared) and all(has_split(before[tid]) and has_split(after[tid]) for tid in shared)
    for tid in shared:
        value = after[tid]
        name = group(value["name"], tid, pid)
        groups[name] += (
            100 * (value["ticks"] - before[tid]["ticks"]) / (hz * elapsed)
        )
        if split_complete:
            user_groups[name] += 100 * (value["user_ticks"] - before[tid]["user_ticks"]) / (hz * elapsed)
            system_groups[name] += 100 * (value["system_ticks"] - before[tid]["system_ticks"]) / (hz * elapsed)
    adjacent = defaultdict(float)
    adjacent_user, adjacent_system = defaultdict(float), defaultdict(float)
    adjacent_complete, adjacent_seen = True, False
    for left, right in zip(selected, selected[1:]):
        old, new = left[role + "_threads"], right[role + "_threads"]
        for tid in old.keys() & new.keys():
            value = new[tid]
            adjacent[group(value["name"], tid, pid)] += (
                100 * (value["ticks"] - old[tid]["ticks"]) / (hz * elapsed)
            )
            adjacent_seen = True
            if has_split(old[tid]) and has_split(value):
                name = group(value["name"], tid, pid)
                adjacent_user[name] += 100 * (value["user_ticks"] - old[tid]["user_ticks"]) / (hz * elapsed)
                adjacent_system[name] += 100 * (value["system_ticks"] - old[tid]["system_ticks"]) / (hz * elapsed)
            else:
                adjacent_complete = False
    result = {
        "seconds": elapsed,
        "cpu_percent": dict(sorted(groups.items())),
        "included_cpu_percent": sum(groups.values()),
        "adjacent_sample_cpu_percent": dict(sorted(adjacent.items())),
        "changed_threads": sorted(before.keys() ^ after.keys()),
    }
    if split_complete:
        result.update(user_cpu_percent=dict(sorted(user_groups.items())),
                      system_cpu_percent=dict(sorted(system_groups.items())),
                      included_user_cpu_percent=sum(user_groups.values()),
                      included_system_cpu_percent=sum(system_groups.values()))
    if adjacent_seen and adjacent_complete:
        result.update(adjacent_sample_user_cpu_percent=dict(sorted(adjacent_user.items())),
                      adjacent_sample_system_cpu_percent=dict(sorted(adjacent_system.items())))
    return result


def summarize(path, hz):
    host = json.loads((path / "host.json").read_text())
    results = json.loads((path / "results.json").read_text())
    phases = []
    for row in results["results"]:
        start = datetime.fromisoformat(row["started_at"].replace("Z", "+00:00")).timestamp()
        end = start + row["seconds"]
        roles = {}
        for role in ["daemon", "viewer"]:
            pid = results.get(role)
            if not pid:
                continue
            roles[role] = {
                "process_cpu_percent": row[role + "_cpu"],
                "whole_phase": window(host["samples"], start, end, role, pid, hz),
                "first_10_seconds": window(host["samples"], start, min(start + 10, end), role, pid, hz),
                "last_10_seconds": window(host["samples"], max(start, end - 10), end, role, pid, hz),
                "ten_second_windows": [
                    {
                        "offset": offset,
                        "sample": window(host["samples"], start + offset, min(start + offset + 10, end), role, pid, hz),
                    }
                    for offset in range(0, int(row["seconds"]), 10)
                ],
            }
            if role + "_user_cpu" in row and role + "_system_cpu" in row:
                roles[role].update(process_user_cpu_percent=row[role + "_user_cpu"],
                                   process_system_cpu_percent=row[role + "_system_cpu"])
        phases.append({"name": row["name"], "seconds": row["seconds"], "warmup": row.get("warmup", results["initialWarmup"] if row["name"] == "idle-agents-viewer" else results["warmup"]), **roles})
    sibling_limit = 0.02 if host.get("uclamp") else 0.10
    result = {
        "run": path.name,
        "max_sibling_busy": host["max_sibling_busy"],
        "sibling_guard_limit": sibling_limit,
        "sibling_guard_passed": host["max_sibling_busy"] < sibling_limit if host.get("uclamp") else host["max_sibling_busy"] <= sibling_limit,
        "initial_warmup": results["initialWarmup"],
        "later_warmup": results["warmup"],
        "telemetry": results.get("telemetry", False),
        "rich_transcripts": results.get("rich_transcripts", False),
        "corgi_intensity": results.get("corgi_intensity"),
        "resources": results.get("resources"),
        "stream_only": results.get("stream_only", False),
        "phases": phases,
    }
    if "cpu_accounting" in host:
        result["cpu_accounting"] = host["cpu_accounting"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--clock-ticks", type=int, default=os.sysconf("SC_CLK_TCK"))
    args = parser.parse_args()
    value = {
        "note": (
            "CPU user+system; 100%=one core. Thread windows use inner 0.5s sample boundaries "
            "and only threads present at both endpoints; transient thread work may be missed. "
            "Adjacent-sample groups also include threads present for at least one adjacent "
            "sample pair, but still miss work outside each thread's observed lifetime. "
            "Process CPU uses its separate exact measurement window. First/last 10-second "
            "windows overlap when a phase lasts less than 20 seconds. JIT groups describe "
            "observed runtime work, not proven steady-state maintenance. User/system fields "
            "are included only where every contributing thread record provides both counters."
        ),
        "clock_ticks_per_second": args.clock_ticks,
        "runs": [summarize(path, args.clock_ticks) for path in args.runs],
    }
    args.output.write_text(json.dumps(value, indent=2) + "\n")
    for run in value["runs"]:
        print(f'{run["run"]}: sibling max {100 * run["max_sibling_busy"]:.2f}%')
        for phase in run["phases"]:
            for role in ["daemon", "viewer"]:
                record = phase.get(role)
                if not record or not record["whole_phase"] or not record["whole_phase"]["cpu_percent"]:
                    continue
                groups = record["whole_phase"]["cpu_percent"]
                first = record["first_10_seconds"]["cpu_percent"].get("jit", 0)
                last = record["last_10_seconds"]["cpu_percent"].get("jit", 0)
                values = " ".join(f"{name}={cpu:.2f}" for name, cpu in groups.items())
                split = ""
                if record.get("process_user_cpu_percent") is not None and record.get("process_system_cpu_percent") is not None:
                    split = f' user={record["process_user_cpu_percent"]:.2f} system={record["process_system_cpu_percent"]:.2f}'
                print(f'  {phase["name"]} {role}: process={record["process_cpu_percent"]:.2f}{split} {values} JIT10s={first:.2f}->{last:.2f}')


if __name__ == "__main__":
    main()
