#!/usr/bin/env python3
"""Check final evidence completeness and fixture invariants, including failures."""
import argparse
import collections
import hashlib
import json
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--rounds", type=int, default=3)
parser.add_argument("--sleep-seconds", default="180,660")
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
checks, problems = [], []


def check(condition, message):
    (checks if condition else problems).append(message)


core = collections.defaultdict(set)
binaries = collections.defaultdict(set)
counts = collections.Counter()
for product in ["corgi", "herdr"]:
    expected = [(f"{suite}-{index}-{product}", suite) for index in range(1, args.rounds + 1)
                for suite in ["startup", "faults", "stream"]]
    expected += [(f"sleep-{seconds}-{product}", "sleep") for seconds in map(int, filter(None, args.sleep_seconds.split(",")))]
    for name, suite in expected:
        path = root / name
        check((path / "results.json").exists(), f"{name}: results present")
        if not (path / "results.json").exists():
            continue
        manifest = json.loads((path / "manifest.json").read_text())
        binaries[product].add(manifest["sha256"])
        check(manifest["topology"] == "intermediate-bridge-tbf-netem-v2", f"{name}: final network topology")
        check(manifest["args"]["ssh_compression"] == "default", f"{name}: default product SSH settings")
        hashes = json.loads((path / "harness.json").read_text())
        for filename in ["run.py", "observe.ts", "workload.py", "calibrate.py"]:
            saved = hashlib.sha256((path / "harness" / filename).read_bytes()).hexdigest()
            check(saved == hashes[filename], f"{name}: {filename} matches saved hash")
            core[filename].add(saved)
        rows = json.loads((path / "results.json").read_text())
        for row in rows:
            if "before" in row:
                check(row["before"]["ok"], f"{name}/{row['case']}: input acknowledged before fault")
        cases = collections.Counter(r["case"] for r in rows)
        target = {"startup": {"startup": 8}, "faults": {"startup": 1, "tcp_reset": 1, "blackhole3": 1, "blackhole15": 1,
                  "downstream15": 1, "isolated30": 1}, "stream": {"startup": 1, "stream": 8}, "sleep": {"startup": 1, "sleep": 1}}[suite]
        check(dict(cases) == target, f"{name}: all scheduled cases retained")
        counts.update({f"{product}:{key}": value for key, value in cases.items()})
        events = [json.loads(line) for line in (path / "events.jsonl").read_text().splitlines()]
        check(events[-1]["event"] == "cleanup_complete" and events[-1]["namespaces_remaining"] == [], f"{name}: namespace cleanup recorded")
        check(not (path / "failure.txt").exists(), f"{name}: no unhandled harness failure")
        state = json.loads((path / "runtime/atlas/work/atlas-source.json").read_text())
        check((state["cols"], state["rows"]) == (132, 47), f"{name}: active PTY 132x47")
        for observation in path.glob("viewer-*.jsonl"):
            records = [json.loads(line) for line in observation.read_text().splitlines()]
            frames = [r for r in records if r["event"] == "frame"]
            check(all(r["at"] >= r["source"] for r in frames), f"{name}/{observation.name}: synchronized source/observer clocks")
        for spec in path.glob("viewer-*.json"):
            check(set(json.loads(spec.read_text())["env"]) == {"PATH", "LANG", "TERM"}, f"{name}/{spec.name}: no inherited host environment recorded")

for filename, versions in core.items():
    check(len(versions) == 1, f"Identical measurement code across all main trials: {filename}")
for product, hashes in binaries.items():
    check(len(hashes) == 1, f"Identical {product} binary across all main trials")
calibration = json.loads((root / "startup-1-corgi/calibration.json").read_text())
for row in calibration:
    if row["rate"]:
        requested = {"1mbit": 1000, "256kbit": 256, "64kbit": 64}[row["rate"]]
        achieved = row["tcp"]["tail64_kbit_s"]
        check(.9 * requested <= achieved <= 1.1 * requested, f"Independent TCP calibration: {row['rate']}")

report = {"checks_passed": len(checks), "problems": problems, "case_counts_including_setup": counts,
          "measurement_hashes": {k: sorted(v) for k, v in core.items()},
          "binary_hashes": {k: sorted(v) for k, v in binaries.items()}, "checks": checks}
Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"checks_passed": len(checks), "problems": problems}))
raise SystemExit(bool(problems))
