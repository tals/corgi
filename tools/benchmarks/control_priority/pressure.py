#!/usr/bin/env python3
"""Join real control RPC spans to saturated-link sample windows."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "remote_network"))
from summarize import distribution, held_age, rate, receipts

parser = argparse.ArgumentParser()
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
rows = []
for label, root in [("before", args.before), ("after", args.after)]:
    journal = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    assert journal[-1]["event"] == "cleanup_complete"
    epoch = journal[0]["epoch"] - journal[0]["at"]
    spans = []
    for file in (root / "telemetry/local").glob("*.json"):
        trace = json.loads(file.read_text())
        assert trace["dropped_events"] == 0
        for event in trace["traceEvents"]:
            fields = event.get("args", {})
            if event["name"] == "remote.rpc" and fields.get("machine") == "atlas" and fields.get("op") == "session.command":
                spans.append(event)
    delivered = receipts(root)
    for sample in json.loads((root / "results.json").read_text()):
        if sample["case"] != "stream":
            continue
        requests = [e for e in spans if sample["start"] <= e["ts"] / 1e6 - epoch <= sample["end"]]
        assert requests and not sample["failure"]
        rows.append({
            "label": label, "raw": str(root.resolve()), "repeat": sample["repeat"],
            "control_rpc_ms": distribution([e["dur"] / 1000 for e in requests]),
            "control_errors": sum(e["args"]["failed"] for e in requests),
            "control_events": requests,
            "visible_updates_s": sample["frames"] / (sample["end"] - sample["start"]),
            "network": rate(root, sample), "held_age_s": distribution(held_age(sample)),
            "catchup_s": sample["catchup_seconds"], "probes": sample["probes"],
            "input_receipts": {p["token"]: delivered.get(p["token"], []) for p in sample["probes"]},
        })
assert len(rows) == 4
args.output.write_text(json.dumps(rows, indent=2) + "\n")
for row in rows:
    print(json.dumps({k: v for k, v in row.items() if k not in ["control_events", "input_receipts", "probes"]}))
