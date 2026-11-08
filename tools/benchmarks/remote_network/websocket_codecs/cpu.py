#!/usr/bin/env python3
"""Count transport CPU too, so Herdr's SSH compression is not excluded."""

import argparse
import collections
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from summarize import distribution


def load(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    rows, groups, problems = [], collections.defaultdict(list), []
    for manifest in sorted(args.root.glob("*/*/manifest.json")):
        path = manifest.parent
        if path.parent.name not in ("stream-20", "cadence"):
            continue
        meta = load(manifest)
        binary = meta["binary"]
        bridges = set()
        if meta["product"] == "corgi":
            bridges = {
                profile["bridge"]
                for profile in load(path / "machines.json")["machines"]
                if profile.get("bridge")
            }
        samples = [
            json.loads(line)
            for line in (path / "resources.jsonl").read_text().splitlines()
        ]

        def category(process):
            command = process["command"]
            if command.startswith(binary + " "):
                return "application"
            if any(
                command == bridge or command.startswith(bridge + " ")
                for bridge in bridges
            ):
                return "bridge"
            if command.startswith(
                ("/usr/bin/ssh ", "ssh ", "ssh:", "/usr/sbin/sshd ", "sshd:")
            ):
                return "ssh"
            return None

        for row in load(path / "results.json"):
            if row["case"] != "stream":
                continue
            selected = [
                sample
                for sample in samples
                if row["start"] <= sample["at"] <= row["end"]
            ]
            first, last = [
                {process["pid"]: process for process in sample["processes"]}
                for sample in [selected[0], selected[-1]]
            ]
            selected_pids = {pid for pid, process in first.items() if category(process)}
            final_pids = {pid for pid, process in last.items() if category(process)}
            if selected_pids != final_pids:
                problems.append(
                    str(path)
                    + ": selected process roster changed during "
                    + row["kind"]
                )
            elapsed = selected[-1]["at"] - selected[0]["at"]
            cpu = {name: 0.0 for name in ("application", "bridge", "ssh")}
            for pid in selected_pids & final_pids:
                cpu[category(first[pid])] += (
                    (last[pid]["cpu_ticks"] - first[pid]["cpu_ticks"])
                    / os.sysconf("SC_CLK_TCK")
                    / elapsed
                )
            namespace = (
                sum(
                    last[pid]["cpu_ticks"] - process["cpu_ticks"]
                    for pid, process in first.items()
                    if pid in last
                )
                / os.sysconf("SC_CLK_TCK")
                / elapsed
            )
            label = path.name.rsplit("-", 1)[0]
            key = (path.parent.name, label, row["kind"])
            value = {
                "key": list(key),
                "application_cores": cpu["application"],
                "bridge_cores": cpu["bridge"],
                "ssh_cores": cpu["ssh"],
                "combined_cores": sum(cpu.values()),
                "all_namespace_cores": namespace,
                "evidence": str(path.resolve() / "resources.jsonl"),
                "elapsed": elapsed,
                "processes": [
                    {"kind": category(first[pid]), **first[pid]}
                    for pid in sorted(selected_pids)
                ],
            }
            rows.append(value)
            groups[key].append(value)
    summary = [
        {
            "key": list(key),
            "metrics": {
                field: distribution([row[field] for row in values])
                for field in (
                    "application_cores",
                    "bridge_cores",
                    "ssh_cores",
                    "combined_cores",
                    "all_namespace_cores",
                )
            },
        }
        for key, values in sorted(groups.items())
    ]
    assert len(rows) == 48 and all(len(values) == 3 for values in groups.values())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps({"trials": rows, "summary": summary, "problems": problems}, indent=2)
        + "\n"
    )
    print(
        json.dumps(
            {
                "samples": len(rows),
                "problems": problems,
                "max_namespace_cores": max(row["all_namespace_cores"] for row in rows),
            }
        )
    )
    return bool(problems)


if __name__ == "__main__":
    raise SystemExit(main())
