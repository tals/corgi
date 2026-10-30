#!/usr/bin/env python3
"""Summarize phase snapshots. Wall spans overlap; they are not additive CPU."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    results = json.loads((args.directory / "results.json").read_text())
    phases = []
    events = []
    for row in results["results"]:
        path = args.directory / f"{row['name']}-telemetry.json"
        if not path.exists():
            continue
        snapshots = json.loads(path.read_text())
        before = {(s["pid"], s["thread"]): s for s in snapshots["before"]}
        processes = []
        for end in snapshots["after"]:
            start = before.get((end["pid"], end["thread"]))
            if start is None:
                raise ValueError(f"Missing initial snapshot for {end['pid']}/{end['thread']}")
            seconds = (end["at"] - start["at"]) / 1000
            old = {m["name"]: m for m in start["metrics"]}
            metrics = []
            for m in end["metrics"]:
                delta = {key: m[key] - old[m["name"]][key] for key in ["calls", "wall_ms", "bytes"]}
                if delta["calls"]:
                    metrics.append(dict(name=m["name"], **delta,
                                        calls_per_second=delta["calls"] / seconds,
                                        wall_percent=delta["wall_ms"] / (seconds * 10),
                                        bytes_per_second=delta["bytes"] / seconds))
            role = "daemon" if end["pid"] == results["daemon"] else "viewer"
            processes.append(dict(role=role, pid=end["pid"], thread=end["thread"],
                                  seconds=seconds, memory=end["memory"],
                                  metrics=sorted(metrics, key=lambda m: m["wall_ms"], reverse=True)))
            first = (start["epoch_ms"] + start["at"]) * 1000
            last = (end["epoch_ms"] + end["at"]) * 1000
            for event in end["traceEvents"]:
                if event["ts"] <= last and event["ts"] + event["dur"] >= first:
                    clipped = dict(event)
                    clipped["ts"] = max(first, event["ts"])
                    clipped["dur"] = max(0, min(last, event["ts"] + event["dur"]) - clipped["ts"])
                    events.append(clipped)
        phases.append(dict(name=row["name"], seconds=row["seconds"],
                           daemon_cpu=row["daemon_cpu"], viewer_cpu=row["viewer_cpu"],
                           processes=processes))
    summary = dict(notes=["CPU is measured separately by /proc across all process threads.",
                          "Wall spans include waits, nested work, and possible descheduling; do not sum them as CPU.",
                          "Byte counters refer to named boundaries and can count the same payload more than once.",
                          "Aggregate deltas count completed spans, including those started before a phase. Still-open spans are absent.",
                          "Worker cpuUsage is process-wide, and deliberately not summed here."], phases=phases)
    (args.directory / "telemetry-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    if events:
        (args.directory / "timeline.json").write_text(json.dumps(dict(traceEvents=events)))
    for phase in phases:
        print(phase["name"], "CPU", round(phase["daemon_cpu"], 3), phase["viewer_cpu"])
        for process in phase["processes"]:
            print(" ", process["role"], "thread", process["thread"])
            for metric in process["metrics"][:12]:
                print(f"    {metric['name']}: {metric['calls_per_second']:.1f}/s, "
                      f"{metric['wall_percent']:.3f}% elapsed, {metric['bytes_per_second']:.0f} B/s")


if __name__ == "__main__":
    main()
