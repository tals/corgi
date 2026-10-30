#!/usr/bin/env python3
"""Count Bun CPU-profile samples inside the cost matrix's measured phases.

Usage: python3 tools/benchmarks/terminal_costs_profile.py dist/profile-minimal
The profile's timestamps select samples; they never weight their CPU cost.
"""

import argparse
import collections
import datetime
import hashlib
import json
import pathlib


def epoch_us(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1e6


def summarize(profile, start_us, end_us, top):
    nodes = {node["id"]: node for node in profile["nodes"]}
    parents = {child: node["id"] for node in profile["nodes"] for child in node.get("children", [])}
    frames = {
        node_id: (
            node["callFrame"]["functionName"],
            node["callFrame"].get("url", ""),
            node["callFrame"]["lineNumber"] + 1,
            node["callFrame"]["columnNumber"] + 1,
        )
        for node_id, node in nodes.items()
    }
    own = collections.Counter()
    inclusive = collections.Counter()
    stacks = collections.Counter()
    count = 0
    at = profile["startTime"]
    for sample, delta in zip(profile["samples"], profile["timeDeltas"], strict=True):
        at += delta
        if not start_us <= at < end_us:
            continue
        count += 1
        own[frames[sample]] += 1
        stack = []
        while sample is not None:
            stack.append(frames[sample])
            sample = parents.get(sample)
        inclusive.update(set(stack))
        stacks[tuple(stack[:6])] += 1

    def frame_object(frame):
        function, url, line, column = frame
        return {"function": function, "url": url, "line": line, "column": column}

    def table(counter):
        return [
            {**frame_object(frame), "samples": hits, "sample_share_percent": 100 * hits / count}
            for frame, hits in counter.most_common(top)
        ]

    return {
        "start_epoch_us": start_us,
        "end_epoch_us": end_us,
        "samples": count,
        "self": table(own),
        "inclusive": table(inclusive),
        "leaf_first_stacks": [
            {
                "frames": [frame_object(frame) for frame in stack],
                "samples": hits,
                "sample_share_percent": 100 * hits / count,
            }
            for stack, hits in stacks.most_common(top)
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    parser.add_argument("--role", choices=["viewer", "daemon"], default="viewer")
    parser.add_argument("--top", type=int, default=30)
    args = parser.parse_args()
    results_path = args.directory / "results.json"
    results = json.loads(results_path.read_text())
    pid = results[args.role]
    paths = list(args.directory.glob(f"CPU.*.{pid}.0.*.cpuprofile"))
    if len(paths) != 1:
        parser.error(f"expected one main-thread CPU profile for {args.role} PID {pid}; found {len(paths)}")
    profile_path = paths[0]
    raw = profile_path.read_bytes()
    profile = json.loads(raw)
    phases = []
    for phase in results["results"]:
        start = epoch_us(phase["started_at"])
        end = start + phase["seconds"] * 1e6
        if end <= profile["startTime"] or start >= profile["endTime"]:
            continue
        phases.append({"name": phase["name"], **summarize(profile, start, end, args.top)})
    if not phases:
        parser.error("no phase overlaps profile; this script expects Bun profile timestamps in epoch microseconds")
    deltas = sorted(profile["timeDeltas"])
    report = {
        "profile": str(profile_path),
        "profile_sha256": hashlib.sha256(raw).hexdigest(),
        "results": str(results_path),
        "role": args.role,
        "pid": pid,
        "method": "Each recorded sample counts once. startTime plus cumulative timeDeltas selects the phase.",
        "limits": [
            "timeDeltas include idle waits; their sum is elapsed time, not sampled CPU time.",
            "Shares describe sampled main-thread execution, not process CPU percentages or predicted savings.",
            "Inclusive rows overlap. A recursive frame counts at most once per sample.",
            "Native work may appear in an FFI wrapper's self samples; the wrapper's self share is not allocation attribution.",
            "Compiler, GC and other auxiliary-thread CPU is not attributed by this main-thread profile.",
            "Line and column numbers are one-based positions in the compiled bundle, not repository source.",
            "Short phases and low sample counts provide diagnostic ranking, not precise cost estimates.",
        ],
        "timestamp_gap_diagnostics": {
            "median_us": deltas[len(deltas) // 2],
            "p95_us": deltas[int(len(deltas) * 0.95)],
            "gaps_over_10ms": sum(delta > 10_000 for delta in deltas),
        },
        "all": summarize(profile, profile["startTime"], profile["endTime"], args.top),
        "phases": phases,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
