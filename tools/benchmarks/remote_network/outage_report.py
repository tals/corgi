#!/usr/bin/env python3
"""Audit and summarize the before/after outage comparison without dropping failures."""
import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
from summarize import distribution, receipts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("output")
    args = parser.parse_args()
    root, output = Path(args.root).resolve(), Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    plan = json.loads((root / "plan.json").read_text())
    cases = plan["cases"].split(",")
    labels = ["before", "after", "herdr"]
    groups = collections.defaultdict(list)
    checks, problems, trials = [], [], []
    hashes, binaries, cpu_sets = collections.defaultdict(set), collections.defaultdict(set), collections.defaultdict(list)
    def check(value, message):
        (checks if value else problems).append(message)
    for repeat in range(1, plan["repeats"] + 1):
        for label in labels:
            name = f"{label}-{repeat}"
            path = root / name
            check((path / "results.json").exists(), f"{name}: results retained")
            if not (path / "results.json").exists():
                continue
            manifest = json.loads((path / "manifest.json").read_text())
            raw = json.loads((path / "results.json").read_text())
            receipt = receipts(path)
            events = [json.loads(line) for line in (path / "events.jsonl").read_text().splitlines()]
            binaries[label].add(manifest["sha256"])
            cpu_sets[label].append(manifest["args"]["cpus"])
            check(not manifest["args"]["trace"], f"{name}: telemetry disabled")
            check(manifest["args"]["ssh_compression"] == "default", f"{name}: default SSH compression")
            check(manifest["topology"] == "intermediate-bridge-tbf-netem-v2", f"{name}: shared network topology")
            check(collections.Counter(row["case"] for row in raw) == collections.Counter(["startup", *cases]), f"{name}: all scheduled cases retained")
            check(events[-1]["event"] == "cleanup_complete" and not events[-1]["namespaces_remaining"], f"{name}: namespace cleanup completed")
            check(not (path / "failure.txt").exists(), f"{name}: no harness failure")
            check(all(len(records) == 1 for records in receipt.values()), f"{name}: no duplicate input tokens")
            saved = json.loads((path / "harness.json").read_text())
            for filename in ["run.py", "observe.ts", "workload.py"]:
                digest = hashlib.sha256((path / "harness" / filename).read_bytes()).hexdigest()
                check(digest == saved[filename], f"{name}: saved {filename} matches manifest")
                hashes[filename].add(digest)
            for capture in path.glob("viewer-*.ansi"):
                check(b"Traceback (most recent call last)" not in capture.read_bytes(), f"{name}/{capture.name}: no producer traceback")
            for capture in path.glob("viewer-*.jsonl"):
                records = [json.loads(line) for line in capture.read_text().splitlines()]
                check(all(r["at"] >= r["source"] for r in records if r["event"] == "frame"), f"{name}/{capture.name}: clocks consistent")
            rows = []
            for original in raw:
                if original["case"] == "startup":
                    check(original.get("usable_seconds") is not None, f"{name}: setup attach succeeded")
                    continue
                row = dict(original)
                tag = f"{name}/{row['case']}"
                row.update(label=label, trial=repeat, evidence=str(path / "results.json"))
                check(row["before"]["ok"] and row["echo"]["ok"], f"{tag}: input worked before and after")
                check(row["usable_seconds"] is not None and row["recovery_seconds"] is not None, f"{tag}: recovery observed")
                check(not row.get("failure"), f"{tag}: no recorded failure")
                check(row["fault_seconds"] <= row["actual_fault_seconds"] < row["fault_seconds"] + 2, f"{tag}: outage duration retained")
                for field in ["before", "echo"]:
                    check(len(receipt.get(row[field]["token"], [])) == 1, f"{tag}: {field} echo has one independent receipt")
                row["ready_receipts"] = receipt.get(row["ready"]["ack"], [])
                check(len(row["ready_receipts"]) == 1, f"{tag}: usable-input echo has one independent receipt")
                row["during_receipts"] = receipt.get(f"DURING{row['case']}{row['repeat']}", [])
                row["late_receipts"] = receipt.get(f"LATE{row['case']}{row['repeat']}", [])
                check(len(row["during_receipts"]) <= 1 and len(row["late_receipts"]) <= 1, f"{tag}: outage input never duplicates")
                for when in ["before", "after"]:
                    producers = row[f"producers_{when}"]
                    check(collections.Counter(p["machine"] for p in producers) == {"local": 4, "atlas": 4, "borealis": 4} and all(p["alive"] for p in producers), f"{tag}: twelve live producers {when}")
                    selected = [p for p in producers if p["source"] == "atlas-source.json"]
                    check(len(selected) == 1 and (selected[0]["cols"], selected[0]["rows"]) == (132, 47), f"{tag}: selected PTY dimensions {when}")
                check({p["pid"] for p in row["producers_before"]} == {p["pid"] for p in row["producers_after"]}, f"{tag}: producer PIDs survived")
                rows.append(row)
                groups[(label, row["case"])].append(row)
            trials.append({"name": name, "manifest": manifest, "results": rows})
    for filename, values in hashes.items():
        check(len(values) == 1, f"Identical {filename} across all products and rounds")
    for label in labels:
        check(len(binaries[label]) == 1, f"Identical {label} binary across rounds")
        check(cpu_sets[label] == [plan["cpu_sets"].split(";")[(labels.index(label) + repeat) % 3] for repeat in range(plan["repeats"])], f"{label}: planned CPU rotation")
    grouped = [{"label": label, "case": case, "usable_seconds": distribution([r["usable_seconds"] for r in rows]),
                "recovery_seconds": distribution([r["recovery_seconds"] for r in rows]), "trials": len(rows)}
               for (label, case), rows in groups.items()]
    audit = {"checks_passed": len(checks), "problems": problems, "checks": checks,
             "binary_hashes": {k: sorted(v) for k, v in binaries.items()},
             "harness_hashes": {k: sorted(v) for k, v in hashes.items()}}
    (output / "summary.json").write_text(json.dumps({"plan": plan, "trials": trials, "groups": grouped}, indent=2) + "\n")
    (output / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    with (output / "trials.csv").open("w") as file:
        writer = csv.writer(file)
        writer.writerow(["label", "trial", "case", "outage_s", "fresh_screen_s", "usable_input_s", "during_receipts", "late_receipts", "evidence"])
        for trial in trials:
            for row in trial["results"]:
                writer.writerow([row["label"], row["trial"], row["case"], row["actual_fault_seconds"], row["recovery_seconds"], row["usable_seconds"], len(row["during_receipts"]), len(row["late_receipts"]), row["evidence"]])
    lines = ["# Outage recovery measurements", "", "Seconds from link restoration to remotely echoed usable input; median [min–max].", "", "| Outage | Rebased Corgi before | Corgi after | Herdr v0.9.5 |", "| --- | ---: | ---: | ---: |"]
    for case in cases:
        cells = []
        for label in labels:
            found = next((g for g in grouped if g["label"] == label and g["case"] == case), None)
            d = found["usable_seconds"] if found else None
            cells.append(f"{d['median']:.3f} [{d['min']:.3f}–{d['max']:.3f}], n={d['n']}" if d and d["n"] else "missing")
        lines.append(f"| {case.removeprefix('blackhole')} s | " + " | ".join(cells) + " |")
    lines += ["", "All scheduled results, including any failures, remain in [trial data](evidence/trials.csv) and [full evidence](evidence/summary.json).", "", "Setup attaches are excluded from these aggregates. Three separate environments per product; the three products run simultaneously on disjoint CPU sets, rotated each round. Each trial uses real SSH, 120 ms RTT, four workloads on each of three machines, and whole-link packet loss for the stated duration. The observer requires matching screen header/footer markers, then a unique remote input echo. See the [playbook](README.md) for methodology and limitations.", "", f"Audit: {len(checks)} checks passed; {len(problems)} problems. [Audit details](evidence/audit.json).", ""]
    (output.parent / "measurements.md").write_text("\n".join(lines))
    print(json.dumps({"checks_passed": len(checks), "problems": problems}))
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main())
