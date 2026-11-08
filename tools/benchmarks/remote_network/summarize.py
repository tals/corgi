#!/usr/bin/env python3
"""Reduce retained observations; missing acknowledgements remain failures."""
import argparse
import collections
import json
import math
from pathlib import Path
import statistics


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * fraction
    lo, hi = math.floor(position), math.ceil(position)
    return values[lo] + (values[hi] - values[lo]) * (position - lo)


def distribution(values):
    values = [v for v in values if v is not None]
    return {"n": len(values), "median": statistics.median(values) if values else None,
            "min": min(values) if values else None, "max": max(values) if values else None,
            "p95": percentile(values, .95)}


def held_age(row):
    frame = row.get("initial_frame")
    frames = list(zip(row["frame_times"], row["frame_sources"]))
    source = frame["source"] if frame else None
    ages, index, sample = [], 0, row["start"]
    while sample <= row["end"]:
        while index < len(frames) and frames[index][0] <= sample:
            source = frames[index][1]
            index += 1
        if source is not None:
            ages.append(sample - source)
        sample += .05
    return ages


def rate(path, row):
    stem = "network-" + row.get("snapshot_prefix", f"stream-{row['kind']}-{row['rate']}-{row['repeat']}")
    snapshots = [json.loads((path / f"{stem}-{which}.json").read_text()) for which in ["start", "end"]]
    first, last = [s["local"] for s in snapshots]
    links = [next(link for link in json.loads(s["links"]) if link["ifname"] == "atlas") for s in [first, last]]
    elapsed = last["at"] - first["at"]
    remotes = [next(link for link in json.loads(s["atlas"]["links"]) if link["ifname"] == "uplink") for s in snapshots]
    return {"tx_kbit_s": (links[1]["stats64"]["rx"]["bytes"] - links[0]["stats64"]["rx"]["bytes"]) * 8 / elapsed / 1000,
            "rx_kbit_s": (remotes[1]["stats64"]["rx"]["bytes"] - remotes[0]["stats64"]["rx"]["bytes"]) * 8 / (snapshots[1]["atlas"]["at"] - snapshots[0]["atlas"]["at"]) / 1000}


def receipts(path):
    result = collections.defaultdict(list)
    for source in path.glob("runtime/*/work/*-input.jsonl"):
        for line in source.read_text().splitlines():
            event = json.loads(line)
            result[event["token"]].append({"machine": source.name, **event})
    return dict(result)


def sleep_evidence(path):
    events = [json.loads(line) for line in (path / "events.jsonl").read_text().splitlines()]
    start = next(e["at"] for e in events if e["event"] == "sleep_start")
    end = next(e["at"] for e in events if e["event"] == "sleep_end")
    samples = [json.loads(line) for line in (path / "resources.jsonl").read_text().splitlines()]
    samples = [s for s in samples if start <= s["at"] <= end]
    producers = [{p["pid"]: p for p in s["processes"] if p["machine"] in ["atlas", "borealis"]
                  and p["command"].startswith("/usr/bin/python3 ") and "workload.py" in p["command"]} for s in samples]
    pids = set(producers[0]) if producers else set()
    frames = [json.loads(line) for line in (path / "viewer-1.jsonl").read_text().splitlines()]
    frames = [f for f in frames if f["event"] == "frame" and f["machine"] == "atlas"]
    before = next((f for f in reversed(frames) if f["at"] < start), None)
    after = next((f for f in frames if f["source"] >= end and f["at"] - f["source"] <= .5), None)
    return {"samples": len(samples), "remote_producer_count": len(pids),
            "same_remote_pids_throughout": bool(pids) and all(set(p) == pids for p in producers),
            "all_remote_cpu_ticks_advanced": bool(pids) and all(producers[-1].get(pid, {}).get("cpu_ticks", 0) > producers[0][pid]["cpu_ticks"] for pid in pids),
            "observed_source_sequence_advance": after["seq"] - before["seq"] if before and after else None,
            "observed_source_seconds": after["source"] - before["source"] if before and after else None}


def summarize(roots, exclusions):
    trials, grouped, excluded = [], collections.defaultdict(list), []
    for root in roots:
        for manifest_path in Path(root).rglob("manifest.json"):
            path = manifest_path.parent
            if path.name in exclusions:
                excluded.append({"path": str(path), "reason": exclusions[path.name]})
                continue
            result_path = path / "results.json"
            if not result_path.exists():
                continue
            manifest = json.loads(manifest_path.read_text())
            receipt = receipts(path)
            record = {"path": str(path), "product": manifest["product"], "manifest": manifest,
                      "receipts": receipt, "duplicate_tokens": {t: v for t, v in receipt.items() if len(v) > 1}, "results": []}
            for row in json.loads(result_path.read_text()):
                row = dict(row)
                key = (manifest["product"], manifest["args"].get("ssh_compression", "default"), row["case"])
                if row["case"] == "startup":
                    # Fault/stream setup attaches are not independent startup samples.
                    if manifest["args"]["suite"] not in ["startup", "smoke"]:
                        continue
                    key += (row["rtt_ms"], row["warm"])
                elif row["case"] == "stream":
                    key += (row["kind"], row["rate"], row.get("loss_percent"), row.get("rtt_ms", 120))
                    ages = held_age(row)
                    row["held_age"] = distribution(ages)
                    row["fresh_fraction_under_500ms"] = sum(x < .5 for x in ages) / len(ages) if ages else 0
                    row["frames_per_second"] = row["frames"] / (row["end"] - row["start"])
                    row["network"] = rate(path, row)
                    row["input_latency"] = distribution([p["seconds"] for p in row["probes"]])
                    row["input_visible"] = sum(p["ok"] for p in row["probes"])
                    row["input_received"] = sum(bool(receipt.get(p["token"])) for p in row["probes"])
                    for field in ["frame_ages", "frame_times", "frame_sources"]:
                        del row[field]
                elif row["case"] == "sleep":
                    key += (row["sleep_seconds"],)
                    row["pending_input_count"] = len(receipt.get("SLEEP_PENDING", []))
                    row["continuity"] = sleep_evidence(path)
                if row.get("ready"):
                    probes = row["ready"]["probes"]
                    row["first_probe_received"] = bool(receipt.get(probes[0]["token"]))
                    row["ready_probe_receipts"] = [len(receipt.get(p["token"], [])) for p in probes]
                if "during_input_at" in row:
                    token = f"DURING{row['case']}{row['repeat']}"
                    row["during_receipts"] = receipt.get(token, [])
                if row.get("late_input_at"):
                    row["late_receipts"] = receipt.get(f"LATE{row['case']}{row['repeat']}", [])
                row["evidence"] = str(result_path)
                record["results"].append(row)
                grouped[key].append(row)
            trials.append(record)
    groups = []
    for key, rows in grouped.items():
        group = {"key": key, "trials": len(rows), "evidence": [r["evidence"] for r in rows]}
        for field in ["remote_seconds", "usable_seconds", "local_seconds", "recovery_seconds", "actual_fault_seconds", "catchup_seconds", "frames_per_second", "fresh_fraction_under_500ms"]:
            if any(field in row for row in rows):
                group[field] = distribution([r.get(field) for r in rows])
        if key[2] == "stream":
            for field in ["median", "p95", "max"]:
                group[f"held_age_{field}"] = distribution([r["held_age"][field] for r in rows])
            group["input_visible"] = sum(r["input_visible"] for r in rows)
            group["input_sent"] = sum(len(r["probes"]) for r in rows)
            group["input_received"] = sum(r["input_received"] for r in rows)
            group["input_latency"] = distribution([p["seconds"] for r in rows for p in r["probes"]])
            group["tx_kbit_s"] = distribution([r["network"]["tx_kbit_s"] for r in rows])
        if any("first_probe_received" in row for row in rows):
            group["first_probe_received"] = sum(r.get("first_probe_received", False) for r in rows)
        group["failures"] = [r for r in rows if r.get("failure")]
        groups.append(group)
    return {"trials": trials, "groups": groups, "excluded": excluded}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("roots", nargs="+")
    parser.add_argument("--exclude", help="JSON mapping of trial folder names to exclusion reasons")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    excluded = json.loads(Path(args.exclude).read_text()) if args.exclude else {}
    Path(args.output).write_text(json.dumps(summarize(args.roots, excluded), indent=2) + "\n")
