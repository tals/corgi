#!/usr/bin/env python3
"""Join opt-in recovery telemetry to the external outage clock."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("output")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    traces = []
    dropped = 0
    for source in sorted((root / "telemetry/local").glob("*.json")):
        trace = json.loads(source.read_text())
        dropped += trace["dropped_events"]
        traces.extend({"file": str(source), **event} for event in trace["traceEvents"] if event.get("args", {}).get("machine") == "atlas")
    tcp = [json.loads(line) for line in (root / "tcp.jsonl").read_text().splitlines()]
    windows = []
    for start in [event for event in events if event["event"] == "fault_start"]:
        end = next(event for event in events if event["event"] == "fault_end" and event["case"] == start["case"] and event["repeat"] == start["repeat"])
        result = next(event for event in events if event["event"] == "result" and event.get("case") == start["case"] and event["repeat"] == start["repeat"])
        selected = []
        for event in traces:
            at, duration = event["ts"] / 1e6, event["dur"] / 1e6
            if at + duration < start["epoch"] or at > result["epoch"]:
                continue
            details = event.get("args", {})
            if event["name"] == "remote.rpc" and duration < .5 and details.get("op") not in ["hello", "link.resume", "session.snapshot", "viewer.stream"]:
                continue
            selected.append({"seconds_from_restoration": at - end["epoch"], "duration_seconds": duration, **event})
        windows.append({"case": start["case"], "repeat": start["repeat"], "fault_start": start,
                        "fault_end": end, "result": result,
                        "trace": sorted(selected, key=lambda event: event["ts"]),
                        "tcp_near_restoration": [sample for sample in tcp if end["at"] - 2 <= sample["at"] <= end["at"] + result["usable_seconds"]]})
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"root": str(root), "manifest": json.loads((root / "manifest.json").read_text()),
                                  "dropped_trace_events": dropped, "windows": windows}, indent=2) + "\n")
    print(json.dumps({"windows": len(windows), "dropped_trace_events": dropped}))


if __name__ == "__main__":
    main()
