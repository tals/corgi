#!/usr/bin/env python3
"""Reduce the compression network matrix, retaining failures and audit evidence."""

import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path

from summarize import distribution, held_age, rate, receipts


def read_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def sleep_continuity(path, events):
    start = next(e["at"] for e in events if e["event"] == "sleep_start")
    end = next(e["at"] for e in events if e["event"] == "sleep_end")
    resources = [
        r for r in read_lines(path / "resources.jsonl") if start <= r["at"] <= end
    ]
    producers = [
        {
            p["pid"]: p
            for p in r["processes"]
            if p["machine"] in ("atlas", "borealis")
            and p["command"].startswith("/usr/bin/python3 ")
            and "workload.py" in p["command"]
        }
        for r in resources
    ]
    pids = set(producers[0]) if producers else set()
    frames = sorted(
        (
            f
            for source in path.glob("viewer-*.jsonl")
            for f in read_lines(source)
            if f["event"] == "frame" and f["machine"] == "atlas"
        ),
        key=lambda f: f["at"],
    )
    before = next((f for f in reversed(frames) if f["at"] < start), None)
    after = next(
        (f for f in frames if f["source"] >= end and f["at"] - f["source"] <= 0.5), None
    )
    return {
        "samples": len(resources),
        "remote_producer_count": len(pids),
        "same_remote_pids_throughout": bool(pids)
        and all(set(p) == pids for p in producers),
        "all_remote_cpu_ticks_advanced": bool(pids)
        and all(
            producers[-1].get(pid, {}).get("cpu_ticks", 0)
            > producers[0][pid]["cpu_ticks"]
            for pid in pids
        ),
        "sequence_advance": after["seq"] - before["seq"] if before and after else None,
        "actual_sleep_seconds": end - start,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    parser.add_argument("output")
    args = parser.parse_args()
    root, output = Path(args.root).resolve(), Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    plan = json.loads((root / "plan.json").read_text())
    checks, problems, trials = [], [], []
    groups = collections.defaultdict(list)
    hashes = collections.defaultdict(set)
    binaries = collections.defaultdict(set)

    def check(condition, message):
        (checks if condition else problems).append(message)

    saved = json.loads((root / "harness.json").read_text())
    for name, digest in saved.items():
        check(
            hashlib.sha256((root / "harness" / name).read_bytes()).hexdigest()
            == digest,
            f"Archived {name} matches hash",
        )
    execution = read_lines(root / "execution.jsonl")
    for suite_index, suite in enumerate(plan["suites"].split(",")):
        labels = (
            ["corgi-identity", "herdr-identity"]
            if suite == "identity"
            else ["corgi-stock", "corgi-zstd", "herdr-stock", "herdr-zstd"]
        )
        for repeat in range(plan["repeats"]):
            for label_index, label in enumerate(labels):
                name = f"{label}-{repeat + 1}"
                path = root / suite / name
                tag = f"{suite}/{name}"
                done = [
                    e
                    for e in execution
                    if e["event"] == "exit"
                    and e["suite"] == suite
                    and e["name"] == name
                ]
                check(len(done) == 1 and done[0]["code"] == 0, f"{tag}: completed lab")
                if not (path / "results.json").exists():
                    check(False, f"{tag}: missing results")
                    continue
                manifest = json.loads((path / "manifest.json").read_text())
                events = read_lines(path / "events.jsonl")
                receipt = receipts(path)
                raw = json.loads((path / "results.json").read_text())
                trial = {
                    "suite": suite,
                    "label": label,
                    "repeat": repeat + 1,
                    "path": str(path),
                    "manifest": manifest,
                    "results": [],
                }
                product, codec = label.split("-")
                binaries[product].add(manifest["sha256"])
                ssh_commands = sorted(
                    {
                        p["command"].strip()
                        for sample in read_lines(path / "resources.jsonl")
                        for p in sample["processes"]
                        if p["machine"] == "local"
                        and p["command"].startswith("/usr/bin/ssh ")
                        and (
                            "remote-client-bridge" in p["command"]
                            or "corgi-remote-bridge" in p["command"]
                        )
                    }
                )
                trial["observed_ssh_commands"] = ssh_commands
                check(bool(ssh_commands), f"{tag}: observed actual bridge SSH command")
                if codec == "stock":
                    check(
                        all(" -C " in command for command in ssh_commands),
                        f"{tag}: stock application enables SSH compression",
                    )
                elif codec == "zstd":
                    check(
                        all(
                            " -C " not in command and "Compression=no" in command
                            for command in ssh_commands
                        ),
                        f"{tag}: zstd bridge disables SSH compression",
                    )
                first = (
                    plan["cpu_start"]
                    + suite_index * 16
                    + ((label_index + repeat) % len(labels)) * 4
                )
                check(
                    manifest["args"]["cpus"] == f"{first}-{first + 3}",
                    f"{tag}: CPU rotation",
                )
                check(
                    manifest["topology"] == "intermediate-bridge-tbf-netem-v2",
                    f"{tag}: topology",
                )
                check(
                    not manifest["args"]["trace"]
                    and not manifest["args"]["capture"]
                    and not manifest["args"]["trace_ssh"],
                    f"{tag}: diagnostics disabled",
                )
                check(
                    events[-1]["event"] == "cleanup_complete"
                    and not events[-1]["namespaces_remaining"],
                    f"{tag}: namespaces cleaned",
                )
                check(
                    not (path / "failure.txt").exists(), f"{tag}: no harness exception"
                )
                for capture in path.glob("viewer-*.jsonl"):
                    check(
                        all(
                            f["at"] >= f["source"]
                            for f in read_lines(capture)
                            if f["event"] == "frame"
                        ),
                        f"{tag}/{capture.name}: clock consistency",
                    )
                for filename, digest in json.loads(
                    (path / "harness.json").read_text()
                ).items():
                    hashes[filename].add(digest)
                    check(
                        hashlib.sha256(
                            (path / "harness" / filename).read_bytes()
                        ).hexdigest()
                        == digest,
                        f"{tag}: saved {filename}",
                    )
                if codec != "stock":
                    info = manifest["codec"]
                    check(
                        info["mode"] == codec
                        and not info["dictionary"]
                        and info["ssh_compression"]
                        == ("no" if codec == "zstd" else "yes"),
                        f"{tag}: codec configuration",
                    )
                    check(
                        info["bridge_sha256"] == saved["codec_bridge.ts"],
                        f"{tag}: measured adapter source",
                    )
                    codec_log = (
                        read_lines(path / "codec.jsonl")
                        if (path / "codec.jsonl").exists()
                        else []
                    )
                    trial["codec_connections"] = len(codec_log)
                    trial["codec_errors"] = [
                        failure for row in codec_log for failure in row["failures"]
                    ]
                    check(bool(codec_log), f"{tag}: adapter evidence present")
                    check(
                        all(
                            any(
                                s in error
                                for s in (
                                    "Premature close",
                                    "EPIPE",
                                    "ECONNRESET",
                                    "write after end",
                                )
                            )
                            for error in trial["codec_errors"]
                        ),
                        f"{tag}: no unexpected codec errors",
                    )
                scheduled = manifest["args"]["suite"]
                if scheduled == "stream":
                    expected = 1 + len(manifest["args"]["stream_cases"].split(","))
                    profiles = []
                    for case in manifest["args"]["stream_cases"].split(","):
                        kind, cap = (
                            ("sparse", "unlimited")
                            if case == "loss"
                            else case.split(":")
                        )
                        profiles.append(
                            (
                                kind,
                                None if cap == "unlimited" else cap,
                                1 if case == "loss" else None,
                                manifest["args"]["stream_rtt"],
                            )
                        )
                    check(
                        [
                            (r["kind"], r["rate"], r.get("loss_percent"), r["rtt_ms"])
                            for r in raw
                            if r["case"] == "stream"
                        ]
                        == profiles,
                        f"{tag}: all scheduled profiles",
                    )
                elif scheduled == "faults":
                    expected = 1 + len(manifest["args"]["fault_cases"].split(","))
                elif scheduled == "startup":
                    expected = 2 * len(manifest["args"]["rtts"].split(","))
                else:
                    expected = 2
                check(len(raw) == expected, f"{tag}: scheduled case count")
                for row in raw:
                    row = dict(row)
                    if row["case"] == "startup" and scheduled != "startup":
                        check(
                            row.get("usable_seconds") is not None,
                            f"{tag}: setup attached",
                        )
                        trial["setup_startup"] = row
                        continue
                    key = [suite, label, row["case"]]
                    if row["case"] == "stream":
                        key += [
                            row["kind"],
                            row["rate"],
                            row.get("loss_percent"),
                            row["rtt_ms"],
                        ]
                        ages = held_age(row)
                        row["held_age"] = distribution(ages)
                        row["fresh_fraction"] = (
                            sum(age < 0.5 for age in ages) / len(ages) if ages else 0
                        )
                        row["fps"] = row["frames"] / (row["end"] - row["start"])
                        network = rate(path, row)
                        row["down_kbit_s"] = network["tx_kbit_s"]
                        row["up_kbit_s"] = network["rx_kbit_s"]
                        row["total_kbit_s"] = sum(network.values())
                        row["bytes_per_update"] = (
                            row["total_kbit_s"] * 125 / row["fps"]
                            if row["fps"]
                            else None
                        )
                        row["input_visible"] = sum(p["ok"] for p in row["probes"])
                        row["input_received"] = sum(
                            bool(receipt.get(p["token"])) for p in row["probes"]
                        )
                        row["input_duplicates"] = sum(
                            max(0, len(receipt.get(p["token"], [])) - 1)
                            for p in row["probes"]
                        )
                        row["input_latency"] = distribution(
                            [p["seconds"] for p in row["probes"]]
                        )
                        producers = row["producers"]
                        check(
                            collections.Counter(p["machine"] for p in producers)
                            == {"local": 4, "atlas": 4, "borealis": 4}
                            and all(p["alive"] for p in producers),
                            f"{tag}/{row['snapshot_prefix']}: twelve live producers",
                        )
                        check(
                            any(
                                p["source"] == "atlas-source.json"
                                and (p["cols"], p["rows"]) == (132, 47)
                                for p in producers
                            ),
                            f"{tag}/{row['snapshot_prefix']}: matched PTY",
                        )
                        check(
                            plan["stream_seconds"]
                            <= row["end"] - row["start"]
                            < plan["stream_seconds"] + 0.75,
                            f"{tag}/{row['snapshot_prefix']}: sample length",
                        )
                        for field in ("frame_ages", "frame_times", "frame_sources"):
                            del row[field]
                    elif row["case"] == "startup":
                        key += [row["rtt_ms"], row["warm"]]
                    elif row["case"] == "sleep":
                        key += [row["sleep_seconds"]]
                        row["pending_input_count"] = len(
                            receipt.get("SLEEP_PENDING", [])
                        )
                        row["continuity"] = sleep_continuity(path, events)
                    elif "during_input_at" in row:
                        row["during_input_count"] = len(
                            receipt.get(f"DURING{row['case']}{row['repeat']}", [])
                        )
                        row["late_input_count"] = (
                            len(receipt.get(f"LATE{row['case']}{row['repeat']}", []))
                            if row.get("late_input_at")
                            else None
                        )
                        before = {p["source"]: p for p in row["producers_before"]}
                        row["producer_continuity"] = len(before) == 12 and all(
                            p["alive"]
                            and p["pid"] == before[p["source"]]["pid"]
                            and p["seq"] > before[p["source"]]["seq"]
                            for p in row["producers_after"]
                        )
                        check(
                            row["fault_seconds"]
                            <= row["actual_fault_seconds"]
                            < row["fault_seconds"] + 1,
                            f"{tag}/{row['case']}: fault duration",
                        )
                    row["evidence"] = str(path / "results.json")
                    row["key"] = key
                    trial["results"].append(row)
                    groups[tuple(key)].append(row)
                trials.append(trial)
    for filename, values in hashes.items():
        if filename not in ("codec_report.py", "codec_matrix.py"):
            check(len(values) == 1, f"All labs share {filename}")
    for product, values in binaries.items():
        check(len(values) == 1, f"All {product} arms share binary")
    grouped = []
    fields = (
        "fps",
        "down_kbit_s",
        "up_kbit_s",
        "total_kbit_s",
        "bytes_per_update",
        "fresh_fraction",
        "catchup_seconds",
        "remote_seconds",
        "usable_seconds",
        "recovery_seconds",
        "actual_fault_seconds",
    )
    for key, rows in groups.items():
        group = {"key": key, "n": len(rows), "evidence": [r["evidence"] for r in rows]}
        check(len(rows) == plan["repeats"], f"{key}: all repetitions")
        for field in fields:
            if any(field in row for row in rows):
                group[field] = distribution([r.get(field) for r in rows])
        for field in (
            "input_visible",
            "input_received",
            "input_duplicates",
            "during_input_count",
            "late_input_count",
            "pending_input_count",
        ):
            if any(field in row for row in rows):
                group[field] = sum(r.get(field) or 0 for r in rows)
        if rows[0]["case"] == "stream":
            group["p95_age"] = distribution([r["held_age"]["p95"] for r in rows])
            group["input_latency"] = distribution(
                [p["seconds"] for r in rows for p in r["probes"]]
            )
        group["failures"] = [r.get("failure") for r in rows if r.get("failure")]
        group["missing_recovery"] = sum(
            r.get("recovery_seconds") is None for r in rows if "recovery_seconds" in r
        )
        group["missing_usable"] = sum(
            r.get("usable_seconds") is None for r in rows if "usable_seconds" in r
        )
        grouped.append(group)
    summary = {"plan": plan, "groups": grouped}
    audit = {
        "checks_passed": len(checks),
        "problems": problems,
        "checks": checks,
        "binary_hashes": {k: sorted(v) for k, v in binaries.items()},
        "harness_hashes": {k: sorted(v) for k, v in hashes.items()},
        "non_lab_source_variants": {
            "explanation": "Lab setup archives every neighboring benchmark tool. The reducer was developed during the run, and the already-loaded coordinator was extended to launch the independent 20 ms suite. Neither file is executed by lab children. Each matrix root retains its originally executed coordinator. Application binaries, codec bridge, codec runner, network runner, observer and producer are identical across matched arms.",
            "files": {
                k: sorted(v)
                for k, v in hashes.items()
                if k in ("codec_report.py", "codec_matrix.py")
            },
        },
    }
    for name, data in (("summary", summary), ("trials", trials), ("audit", audit)):
        (output / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")
    with (output / "measurements.csv").open("w") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "scenario",
                "n",
                *fields,
                "p95_age",
                "input_latency",
                "input_visible",
                "input_received",
            ],
        )
        writer.writeheader()
        for group in grouped:
            writer.writerow(
                {
                    "scenario": "/".join(map(str, group["key"])),
                    "n": group["n"],
                    **{
                        key: (
                            group[key].get("median")
                            if isinstance(group[key], dict)
                            else group[key]
                        )
                        for key in writer.fieldnames[2:]
                        if key in group
                    },
                }
            )
    print(
        json.dumps(
            {
                "trials": len(trials),
                "groups": len(grouped),
                "checks_passed": len(checks),
                "problems": problems,
            },
            indent=2,
        )
    )
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main())
