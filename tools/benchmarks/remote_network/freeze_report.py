#!/usr/bin/env python3
"""Reduce the four stock-Herdr freeze controls and retain independent evidence."""

import argparse
import collections
import hashlib
import json
from pathlib import Path

from codec_report import sleep_continuity
from summarize import distribution, receipts


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    parser.add_argument("output")
    args = parser.parse_args()
    root, output = Path(args.root).resolve(), Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    checks, problems, trials = [], [], []
    hashes = collections.defaultdict(set)
    groups = collections.defaultdict(list)

    def check(ok, message):
        (checks if ok else problems).append(message)

    execution = json.loads((root / "execution.json").read_text())
    for item in execution:
        path = root / item["name"]
        check(item["code"] == 0, f"{item['name']}: completed")
        events = lines(path / "events.jsonl")
        manifest = json.loads((path / "manifest.json").read_text())
        results = json.loads((path / "results.json").read_text())
        check(
            len(results) == 2 and [r["case"] for r in results] == ["startup", "sleep"],
            f"{item['name']}: scheduled cases",
        )
        result = results[-1]
        receipt = receipts(path)
        continuity = sleep_continuity(path, events)
        check(
            continuity["remote_producer_count"] == 8
            and continuity["same_remote_pids_throughout"]
            and continuity["all_remote_cpu_ticks_advanced"],
            f"{item['name']}: remote work continued",
        )
        check(
            180 <= continuity["actual_sleep_seconds"] < 181,
            f"{item['name']}: actual freeze duration",
        )
        expected_input = 0 if result["control"] == "no-pending-input" else 1
        check(
            len(receipt.get("SLEEP_PENDING", [])) == expected_input,
            f"{item['name']}: pending input received once when scheduled",
        )
        check(
            result["echo"]["ok"]
            and len(receipt.get(result["echo"]["token"], [])) == 1
            and len(receipt.get(result["ready"]["ack"], [])) == 1,
            f"{item['name']}: after-wake echo and receipt",
        )
        check(
            events[-1]["event"] == "cleanup_complete"
            and not events[-1]["namespaces_remaining"],
            f"{item['name']}: cleanup",
        )
        check(not (path / "failure.txt").exists(), f"{item['name']}: no harness error")
        check(
            manifest["sha256"]
            == "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d",
            f"{item['name']}: unchanged stock binary",
        )
        for filename, digest in json.loads((path / "harness.json").read_text()).items():
            hashes[filename].add(digest)
            check(
                hashlib.sha256((path / "harness" / filename).read_bytes()).hexdigest()
                == digest,
                f"{item['name']}: {filename} matches archived hash",
            )
        negotiation = "\n".join(
            p.read_text() for p in (path / "ssh-debug").glob("*.log")
        )
        check(
            "compression: zlib@openssh.com" in negotiation
            and "compression: none" not in negotiation,
            f"{item['name']}: normal SSH compression",
        )
        for machine in ["local", "atlas"]:
            log = (path / f"packets-{machine}.log").read_text()
            check(
                "0 packets dropped by kernel" in log,
                f"{item['name']}: {machine} packet capture has no kernel drops",
            )
        record = {
            "name": item["name"],
            "path": str(path),
            "result": result,
            "continuity": continuity,
            "pending_input_count": len(receipt.get("SLEEP_PENDING", [])),
            "manifest": manifest,
        }
        trials.append(record)
        groups[result["control"]].append(record)
    for name, values in hashes.items():
        check(len(values) == 1, f"All controls share {name}")
    summary = []
    for case, records in groups.items():
        check(len(records) == 3, f"{case}: three repetitions")
        summary.append(
            {
                "case": case,
                "n": len(records),
                "fresh_seconds": distribution(
                    [r["result"]["recovery_seconds"] for r in records]
                ),
                "usable_seconds": distribution(
                    [r["result"]["usable_seconds"] for r in records]
                ),
                "evidence": [r["path"] + "/results.json" for r in records],
            }
        )
    audit = {
        "checks_passed": len(checks),
        "checks": checks,
        "problems": problems,
        "harness_hashes": {k: sorted(v) for k, v in hashes.items()},
    }
    for name, data in [("summary", summary), ("trials", trials), ("audit", audit)]:
        (output / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")
    print(
        json.dumps(
            {"trials": len(trials), "checks_passed": len(checks), "problems": problems},
            indent=2,
        )
    )
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main())
