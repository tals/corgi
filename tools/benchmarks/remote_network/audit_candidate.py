#!/usr/bin/env python3
"""Audit candidate completeness, workload survival and independent input receipts."""
import argparse
import collections
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("summary")
parser.add_argument("output")
parser.add_argument("--repeats", type=int, default=3)
args = parser.parse_args()
root = Path(args.root)
summary = json.loads(Path(args.summary).read_text())
checks, problems = [], []
hashes, binaries = collections.defaultdict(set), collections.defaultdict(set)


def check(condition, message):
    (checks if condition else problems).append(message)


expected = [f"{suite}-{i}-corgi" for i in range(1, args.repeats + 1) for suite in ["stream", "startup", "faults"]]
expected += ["sleep-180-corgi", "sleep-660-corgi", "stream-control-herdr"]
for name in expected:
    path = root / name
    check((path / "results.json").exists(), f"{name}: results present")
    if not (path / "results.json").exists():
        continue
    manifest = json.loads((path / "manifest.json").read_text())
    binaries[manifest["product"]].add(manifest["sha256"])
    check(manifest["topology"] == "intermediate-bridge-tbf-netem-v2", f"{name}: unchanged network topology")
    check(manifest["args"]["ssh_compression"] == "default", f"{name}: default SSH settings")
    saved = json.loads((path / "harness.json").read_text())
    for filename in ["run.py", "observe.ts", "workload.py", "calibrate.py"]:
        digest = hashlib.sha256((path / "harness" / filename).read_bytes()).hexdigest()
        check(digest == saved[filename], f"{name}: saved {filename} matches manifest")
        hashes[filename].add(digest)
    rows = json.loads((path / "results.json").read_text())
    cases = collections.Counter(row["case"] for row in rows)
    suite = manifest["args"]["suite"]
    wanted = {"startup": {"startup": 8}, "stream": {"startup": 1, "stream": 8},
              "faults": {"startup": 1, "tcp_reset": 1, "blackhole3": 1, "blackhole15": 1, "downstream15": 1, "isolated30": 1},
              "sleep": {"startup": 1, "sleep": 1}}[suite]
    check(cases == wanted, f"{name}: all scheduled measurements retained")
    for index, row in enumerate(rows):
        tag = f"{name}/{index}/{row['case']}"
        check(not row.get("failure"), f"{tag}: no application or producer failure")
        if "before" in row:
            check(row["before"]["ok"], f"{tag}: input worked before impairment")
        if row["case"] == "stream":
            producers = row.get("producers", [])
            counts = collections.Counter(p["machine"] for p in producers)
            check(counts == {"local": 4, "atlas": 4, "borealis": 4} and all(p["alive"] for p in producers), f"{tag}: twelve live producers")
            selected = [p for p in producers if p["source"] == "atlas-source.json"]
            check(len(selected) == 1 and (selected[0]["cols"], selected[0]["rows"]) == (132, 47), f"{tag}: selected PTY dimensions")
            check(row["catchup_seconds"] is not None, f"{tag}: screen caught up after cap removal")
        if row["case"] == "isolated30":
            check(len(row["isolation"]) == 2 and all(p["echo"]["ok"] for p in row["isolation"]), f"{tag}: other machines remained usable")
    events = [json.loads(line) for line in (path / "events.jsonl").read_text().splitlines()]
    check(events[-1]["event"] == "cleanup_complete" and not events[-1]["namespaces_remaining"], f"{name}: namespaces cleaned")
    check(not (path / "failure.txt").exists(), f"{name}: harness completed")
    for capture in path.glob("viewer-*.ansi"):
        check(b"Traceback (most recent call last)" not in capture.read_bytes(), f"{name}/{capture.name}: no producer traceback")
    for capture in path.glob("viewer-*.jsonl"):
        records = [json.loads(line) for line in capture.read_text().splitlines()]
        check(all(r["at"] >= r["source"] for r in records if r["event"] == "frame"), f"{name}/{capture.name}: common monotonic clock")

for trial in summary["trials"]:
    name = Path(trial["path"]).name
    check(not trial["duplicate_tokens"], f"{name}: no duplicate input tokens")
    for row in trial["results"]:
        if row["case"] == "stream":
            check(row["input_visible"] <= row["input_received"], f"{name}/{row['snapshot_prefix']}: visible echoes have remote receipts")
        if row["case"] == "sleep":
            continuity = row["continuity"]
            check(continuity["remote_producer_count"] == 8 and continuity["same_remote_pids_throughout"] and continuity["all_remote_cpu_ticks_advanced"], f"{name}: all remote workloads survived")
            check(row["pending_input_count"] == 1, f"{name}: pending input executed once")
for filename, values in hashes.items():
    check(len(values) == 1, f"Identical {filename} across candidate and Herdr control")
for product, values in binaries.items():
    check(len(values) == 1, f"Identical {product} binary across trials")
report = {"checks_passed": len(checks), "problems": problems, "checks": checks,
          "measurement_hashes": {k: sorted(v) for k, v in hashes.items()},
          "binary_hashes": {k: sorted(v) for k, v in binaries.items()}}
Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"checks_passed": len(checks), "problems": problems}))
raise SystemExit(bool(problems))
