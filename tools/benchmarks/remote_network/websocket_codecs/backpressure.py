#!/usr/bin/env python3
"""Keep whole-window and late-window age separate across scheduling controls."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from summarize import distribution, held_age


def load(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("matrix", type=Path)
    parser.add_argument("control", type=Path)
    parser.add_argument("trace", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    rows = []
    for cohort, root, suite in [
        ("main", args.matrix, "stream-600-low"),
        ("raw-accounting", args.matrix, "accounting-stream-600-low"),
        ("four-core", args.control, "stream-600-low"),
    ]:
        for file in sorted((root / suite).glob("*/results.json")):
            row = next(row for row in load(file) if row["case"] == "stream")
            ages = held_age(row)
            rows.append(
                {
                    "cohort": cohort,
                    "label": file.parent.name.rsplit("-", 1)[0],
                    "trial": file.parent.name,
                    "evidence": str(file.resolve()),
                    "whole_window": distribution(ages),
                    "last_ten_seconds": distribution(
                        [
                            age
                            for i, age in enumerate(ages)
                            if row["start"] + i * 0.05 >= row["end"] - 10
                        ]
                    ),
                    "fps": row["frames"] / (row["end"] - row["start"]),
                }
            )
    events = [
        json.loads(line)
        for line in (args.trace / "events.jsonl").read_text().splitlines()
    ]
    cap = next(
        event
        for event in events
        if event["event"] == "network" and event.get("rate") == "64kbit"
    )
    windows = []
    dropped = 0
    for file in (args.trace / "telemetry/atlas").glob("*.json"):
        data = load(file)
        dropped += data["dropped_events"]
        windows.extend(
            {"seconds_from_cap": event["ts"] / 1e6 - cap["epoch"], **event["args"]}
            for event in data["traceEvents"]
            if event["name"] == "remote.stream.window"
            and event["ts"] / 1e6 >= cap["epoch"] - 1
        )
    windows.sort(key=lambda event: event["seconds_from_cap"])
    assert len(rows) == 36 and windows and dropped == 0
    assert events[-1]["event"] == "cleanup_complete"
    args.output.write_text(
        json.dumps(
            {
                "trials": rows,
                "trace": str(args.trace.resolve()),
                "dropped_trace_events": dropped,
                "window_events": windows,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
