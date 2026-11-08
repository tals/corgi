#!/usr/bin/env python3
"""Reduce production trials and audit each retained measurement independently."""

import argparse
import collections
import hashlib
import functools
import json
import os
from pathlib import Path

from summarize import distribution, held_age, percentile, rate, receipts, sleep_evidence


def load(path):
    return json.loads(path.read_text())


def lines(path):
    return [json.loads(s) for s in path.read_text().splitlines()]


@functools.cache
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resources(path, row, binary):
    samples = [
        s
        for s in lines(path / "resources.jsonl")
        if row["start"] <= s["at"] <= row["end"]
    ]
    if len(samples) < 2:
        return {}

    def selected(sample):
        return {
            p["pid"]: p
            for p in sample["processes"]
            if p["command"].startswith(binary + " ")
        }

    first, last = selected(samples[0]), selected(samples[-1])
    ticks = sum(
        last[pid]["cpu_ticks"] - p["cpu_ticks"]
        for pid, p in first.items()
        if pid in last
    )
    elapsed = samples[-1]["at"] - samples[0]["at"]
    return {
        "product_cpu_cores": ticks / os.sysconf("SC_CLK_TCK") / elapsed,
        "product_sum_rss_mib": max(
            sum(p["rss_bytes"] for p in selected(s).values()) for s in samples
        )
        / 1048576,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    parser.add_argument("output")
    parser.add_argument("--extra")
    parser.add_argument("--partial", action="store_true")
    args = parser.parse_args()
    root, out = Path(args.root), Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    groups = collections.defaultdict(list)
    trials, checks, problems = [], [], []

    def check(ok, label):
        (checks if ok else problems).append(label)

    manifests = sorted(root.glob("*/*/manifest.json"))
    if args.extra:
        manifests += sorted(Path(args.extra).glob("*/*/manifest.json"))
    plan = load(root / "plan.json")
    expected = len(plan["suites"].split(",")) * 3 * plan["repeats"] + (
        27 if args.extra else 0
    )
    if not args.partial:
        check(
            len(manifests) == expected,
            f"expected {expected} labs, found {len(manifests)}",
        )
    frozen = load(root / "harness.json")
    for manifest_path in manifests:
        path = manifest_path.parent
        suite, label = path.parent.name, path.name.rsplit("-", 1)[0]
        name = suite + "/" + path.name
        if args.partial and not any(
            e["event"] == "cleanup_complete" for e in lines(path / "events.jsonl")
        ):
            continue
        manifest = load(manifest_path)
        check(
            sha(Path(manifest["binary"])) == manifest["sha256"],
            name + ": binary identity",
        )
        check(not (path / "failure.txt").exists(), name + ": runner completed")
        check((path / "results.json").exists(), name + ": results present")
        if not (path / "results.json").exists():
            continue
        cleanup = next(
            (
                e
                for e in reversed(lines(path / "events.jsonl"))
                if e["event"] == "cleanup_complete"
            ),
            None,
        )
        check(
            cleanup is not None and not cleanup["namespaces_remaining"],
            name + ": private namespaces cleaned",
        )
        harness = load(path / "harness.json")
        for file in [
            "run.py",
            "observe.ts",
            "workload.py",
            "adaptive_run.py",
            "freeze_audit.py",
        ]:
            check(harness.get(file) == frozen[file], name + ": unchanged " + file)
        receipt = receipts(path)
        check(
            all(len(events) == 1 for events in receipt.values()),
            name + ": no duplicate input receipts",
        )
        rows = load(path / "results.json")
        args_ = manifest["args"]
        expected_rows = {
            "startup": 2 * len(args_.get("rtts", "").split(",")),
            "navigation": 1 + 4 * len(args_.get("rtts", "").split(",")),
            "stream": 1 + len(args_.get("stream_cases", "").split(",")),
            "faults": 1 + len(args_.get("fault_cases", "").split(",")),
            "sleep": 2,
            "cold-ui": 1,
            "cadence": 3,
            "transition": 4,
        }[args_["suite"]]
        check(len(rows) == expected_rows, name + ": scheduled cases complete")
        reduced = []
        for row in rows:
            case = row["case"]
            for token in [
                row.get("ready", {}).get("ack"),
                (
                    row.get("echo", {}).get("token")
                    if row.get("echo", {}).get("ok")
                    else None
                ),
            ]:
                if token:
                    check(
                        len(receipt.get(token, [])) == 1,
                        name + ": visible " + token + " independently received once",
                    )
            check(not row.get("failure"), name + ": " + case + " application outcome")
            if case in ("stream", "transition"):
                network = rate(path, {"repeat": 0, **row})
                result = {
                    "fps": row["frames"] / (row["end"] - row["start"]),
                    "p95_age": percentile(held_age(row), 0.95),
                    "max_age": max(held_age(row)),
                    "down_kbit_s": network["tx_kbit_s"],
                    "up_kbit_s": network["rx_kbit_s"],
                    "total_kbit_s": sum(network.values()),
                    "catchup_seconds": row.get(
                        "catchup_seconds", row.get("fresh_seconds")
                    ),
                    "echo_seconds": percentile(
                        [
                            p["seconds"]
                            for p in row["probes"]
                            if p["seconds"] is not None
                        ],
                        0.5,
                    ),
                    "inputs": len(row["probes"]),
                    "visible_inputs": sum(p["ok"] for p in row["probes"]),
                    "received_inputs": sum(
                        len(receipt.get(p["token"], [])) for p in row["probes"]
                    ),
                    **resources(path, row, manifest["binary"]),
                }
                check(
                    all(p["alive"] for p in row["producers"])
                    and len(row["producers"]) == 12,
                    name + ": all producers alive",
                )
                key = (
                    suite,
                    label,
                    case,
                    row["kind"],
                    row["rate"],
                    row["rtt_ms"],
                    row.get("loss_percent"),
                    row.get("phase"),
                )
            elif case == "startup":
                result = {
                    k: row.get(k)
                    for k in [
                        "local_seconds",
                        "remote_seconds",
                        "usable_seconds",
                        "sidebar_seconds",
                        "ui_seconds",
                        "first_content_seconds",
                        "click_to_ui_seconds",
                        "click_to_first_content_seconds",
                    ]
                }
                key = (suite, label, case, row["rtt_ms"], row["warm"])
            elif case == "navigation":
                result = {"first_content_seconds": row["first_content_seconds"]}
                key = (
                    suite,
                    label,
                    case,
                    row["rtt_ms"],
                    "cached" if row["tab"] == 0 else "uncached",
                )
            else:
                result = {
                    "fresh_seconds": row.get("recovery_seconds"),
                    "usable_seconds": row.get("usable_seconds"),
                }
                check(
                    result["fresh_seconds"] is not None
                    and result["usable_seconds"] is not None,
                    name + ": " + case + " recovery completed",
                )
                if case == "sleep":
                    continuity = sleep_evidence(path)
                    check(
                        continuity["remote_producer_count"] == 8
                        and continuity["same_remote_pids_throughout"]
                        and continuity["all_remote_cpu_ticks_advanced"],
                        name + ": remote work survived freeze",
                    )
                    pending = sum(
                        len(v) for k, v in receipt.items() if k == "SLEEP_PENDING"
                    )
                    check(
                        pending
                        == (
                            0 if args_.get("sleep_control") == "no-pending-input" else 1
                        ),
                        name + ": pending input receipt",
                    )
                    result["continuity"] = continuity
                if row.get("producers_before"):
                    before = {p["pid"]: p for p in row["producers_before"]}
                    after = {p["pid"]: p for p in row["producers_after"]}
                    check(
                        before.keys() == after.keys()
                        and all(
                            after[p]["alive"] and after[p]["seq"] > v["seq"]
                            for p, v in before.items()
                        ),
                        name + ": " + case + " producer continuity",
                    )
                result["isolation"] = row.get("isolation", [])
                key = (suite, label, case)
            result.update(key=list(key), evidence=str(path / "results.json"))
            groups[key].append(result)
            reduced.append(result)
        trials.append(
            {
                "path": str(path),
                "label": label,
                "sha256": manifest["sha256"],
                "results": reduced,
            }
        )
    summary = []
    for key, values in sorted(groups.items(), key=lambda pair: str(pair[0])):
        metrics = sorted(
            set(k for v in values for k, x in v.items() if isinstance(x, (float, int)))
        )
        summary.append(
            {
                "key": list(key),
                "n": len(values),
                "metrics": {
                    k: distribution([v.get(k) for v in values]) for k in metrics
                },
                "evidence": [v["evidence"] for v in values],
            }
        )
    for name, value in [
        ("summary", summary),
        ("trials", trials),
        (
            "audit",
            {
                "checks_passed": len(checks),
                "checks": checks,
                "problems": problems,
                "labs": len(trials),
                "expected_labs": expected,
                "partial": args.partial,
            },
        ),
    ]:
        (out / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")
    print(
        json.dumps(
            {
                "labs": len(trials),
                "groups": len(summary),
                "checks": len(checks),
                "problems": problems,
            }
        )
    )
    if problems and not args.partial:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
