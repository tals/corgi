#!/usr/bin/env python3
"""Summarize the reader-stall probe and real SSH viewer runs; keep failed probes."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "remote_network"))
from summarize import distribution, held_age, rate, receipts

parser = argparse.ArgumentParser()
parser.add_argument("local", type=Path)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
load = lambda path: json.loads(path.read_text())
dump = lambda name, value: (args.output / name).write_text(json.dumps(value, indent=2) + "\n")
local = load(args.local / "trials.json")
groups = []
for kind in ["sparse", "dense"]:
    for compression in [False, True]:
        row = {"kind": kind, "compression": compression}
        for label in ["before", "after"]:
            trials = [r for r in local if r["label"] == label and r["kind"] == kind and r["compression"] == compression]
            assert len(trials) == 3
            assert all(r["split"] == (label == "after") and int(r["last_frame"]) > 0 for r in trials)
            row[label] = {
                "control_ms": distribution([n for r in trials for n in r["steady"]["samples"]]),
                "paused_ms": distribution([n for r in trials for n in r["paused_samples"]]),
                "updates_s": distribution([r["steady"]["updates_s"] for r in trials]),
                "downstream_bytes_s": distribution([r["steady"]["downstream_bytes_s"] for r in trials]),
            }
        groups.append(row)
dump("local-summary.json", groups)
dump("local-trials.json", local)
dump("local-manifest.json", load(args.local / "manifest.json"))

wan = []
for label, directory in [("before", args.before), ("after", args.after)]:
    manifest = load(directory / "manifest.json")
    delivered = receipts(directory)
    results = load(directory / "results.json")
    assert len([r for r in results if r["case"] == "stream"]) == 6
    assert any(json.loads(line)["event"] == "cleanup_complete" for line in (directory / "events.jsonl").read_text().splitlines())
    for result in results:
        if result["case"] != "stream":
            continue
        assert not result["failure"]
        row = {"label": label, "raw": str(directory.resolve()), **result}
        row["updates_s"] = result["frames"] / (result["end"] - result["start"])
        row["network"] = rate(directory, result)
        row["held_age_s"] = distribution(held_age(result))
        row["visible_probes"] = sum(p["ok"] for p in result["probes"])
        row["received_probes"] = sum(bool(delivered.get(p["token"])) for p in result["probes"])
        row["duplicate_probes"] = sum(len(delivered.get(p["token"], [])) > 1 for p in result["probes"])
        row["input_receipts"] = {p["token"]: delivered.get(p["token"], []) for p in result["probes"]}
        wan.append(row)
    dump(f"wan-{label}-manifest.json", manifest)
dump("wan-trials.json", wan)
wan_groups = []
for kind, limit in [("sparse", "1mbit"), ("dense", None), ("dense", "1mbit")]:
    row = {"kind": kind, "rate": limit}
    for label in ["before", "after"]:
        trials = [r for r in wan if r["label"] == label and r["kind"] == kind and r["rate"] == limit]
        row[label] = {
            "updates_s": distribution([r["updates_s"] for r in trials]),
            "downstream_kbit_s": distribution([r["network"]["tx_kbit_s"] for r in trials]),
            "catchup_s": distribution([r["catchup_seconds"] for r in trials]),
            "input_echo_s": distribution([p["seconds"] for r in trials for p in r["probes"]]),
            "visible_probes": sum(r["visible_probes"] for r in trials),
            "received_probes": sum(r["received_probes"] for r in trials),
            "duplicate_probes": sum(r["duplicate_probes"] for r in trials),
        }
    wan_groups.append(row)
dump("wan-summary.json", wan_groups)
print(json.dumps({"local": groups, "wan": wan_groups}, indent=2))
