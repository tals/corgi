#!/usr/bin/env python3
"""Join external TCP header captures to each outage's restoration timestamp."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess


def packets(path):
    result = subprocess.run(["tcpdump", "-nn", "-tt", "-S", "-r", str(path),
                             "host 10.203.1.2 and tcp port 2222"],
                            text=True, capture_output=True, check=True)
    rows = []
    for line in result.stdout.splitlines():
        found = re.search(r"IP (\S+)\.(\d+) > (\S+)\.(\d+): Flags \[([^]]*)\](.*)", line)
        if not found:
            raise ValueError(f"Unrecognized TCP header: {line}")
        source, port, target, target_port, flags, rest = found.groups()
        sequence = re.search(r"seq (\d+):(\d+)", rest)
        ack = re.search(r"ack (\d+)", rest)
        length = re.search(r"length (\d+)", rest)
        rows.append({"epoch": float(line.split()[0]), "source": source,
                     "source_port": int(port), "target": target, "target_port": int(target_port),
                     "flags": flags, "sequence": [int(x) for x in sequence.groups()] if sequence else None,
                     "ack": int(ack[1]) if ack else None, "bytes": int(length[1]) if length else None,
                     "header": line.split(" ", 1)[1]})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("output")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    captures = {machine: packets(root / f"packets-{machine}.pcap") for machine in ["local", "atlas"]}
    windows = []
    for start in (event for event in events if event["event"] == "fault_start"):
        def matching(kind):
            return next(event for event in events if event["event"] == kind and
                        event.get("case") == start["case"] and event.get("repeat") == start["repeat"])
        end, result = matching("fault_end"), matching("result")
        # The established flow carrying Atlas data just before the fault.
        recent = collections.Counter(packet["target_port"] for packet in captures["local"]
                                     if packet["source"] == "10.203.1.2" and packet["bytes"] and
                                     start["epoch"] - 1 < packet["epoch"] < start["epoch"])
        primary = recent.most_common(1)[0][0]
        selected, first = {}, {}
        for machine, records in captures.items():
            selected[machine] = [{"seconds_from_restoration": p["epoch"] - end["epoch"], **p}
                                 for p in records if start["epoch"] - .2 <= p["epoch"] <= result["epoch"]]
            source = "10.203.1.1" if machine == "local" else "10.203.1.2"
            first[machine] = next((p for p in selected[machine] if p["source"] == source and
                                   p["seconds_from_restoration"] >= 0 and
                                   primary in [p["source_port"], p["target_port"]]), None)
        windows.append({"case": start["case"], "repeat": start["repeat"], "primary_client_port": primary,
                        "fault_start": start, "fault_end": end, "result": result,
                        "first_primary_transmission_after_restoration": first, "packets": selected})
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"root": str(root), "manifest": json.loads((root / "manifest.json").read_text()),
                                  "captures": {machine: {
                                      "sha256": hashlib.sha256((root / f"packets-{machine}.pcap").read_bytes()).hexdigest(),
                                      "log": (root / f"packets-{machine}.log").read_text()}
                                      for machine in captures}, "windows": windows}, indent=2) + "\n")
    print(json.dumps({"windows": len(windows), "output": str(output)}))


if __name__ == "__main__":
    main()
