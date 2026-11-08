#!/usr/bin/env python3
"""Independently reconcile published measurements with kernel and producer receipts."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
plan = read(args.source / "plan.json")
checks = []

def check(condition, label):
    checks.append(dict(passed=bool(condition),label=label))

check(sha(Path(plan["binary"])) == plan["binary_sha256"], "measured executable unchanged")
for name, digest in plan["sources"].items():
    check(sha(root / name) == digest, "measured harness unchanged: " + name)
windows = 0
for repeat in range(int(plan["arguments"]["repeats"])):
    for count in map(int,plan["arguments"]["counts"].split(",")):
        directory = args.source / f"r{repeat}-{count}"
        setup = read(directory / "setup.json")
        result = read(directory / "results.json")
        prefix = directory.name
        check(read(directory / "cleanup.json")["clean"], prefix + ": isolated runtime cleaned up")
        check(not (directory / "failure.txt").exists(), prefix + ": no failed scenario")
        check(len(set(setup["pids"])) == count, prefix + ": distinct provider processes")
        check(all(p["cols"] == 132 and p["rows"] == 47 for p in setup["snapshot"]["panes"] if p["id"] in setup["panes"]), prefix + ": identical provider geometry")
        check(result["build"]["sha256"] == plan["binary_sha256"], prefix + ": executable identity")
        for row in result["rows"]:
            windows += 1
            name = prefix + ": " + row["name"]
            duration = (int(row["end_ns"])-int(row["start_ns"]))/1e9
            check(abs(row["seconds"]-duration) < .1 and max(row["start_jitter_ms"],row["end_jitter_ms"]) < 100, name + ": CPU/wire windows aligned within 100 ms")
            producers = read(directory / (row["name"] + "-producers.json"))
            check(len(producers) == count, name + ": every producer accounted for")
            total = 0
            for i,p in enumerate(producers):
                records = p["records"]
                hz = {"idle":0,"light":2,"spammy":20}[p["mode"]]
                check(p["pid"] == setup["pids"][i] and p["mode"] == row["modes"][i], name + f": lane {i} identity/mode")
                check(all(int(row["start_ns"]) <= int(r[0]) < int(row["end_ns"]) and int(r[1]) >= int(r[0]) for r in records), name + f": lane {i} write timestamps")
                check(len(records) == p["writes"] and abs(len(records)-hz*duration) <= max(2,hz*duration*.02), name + f": lane {i} requested cadence")
                expected_size = {"idle":0,"light":134,"spammy":2144}[p["mode"]]
                check(all(r[3] == expected_size for r in records), name + f": lane {i} complete fixed-size writes")
                total += sum(r[3] for r in records)
            check(abs(total/duration-row["producer_Bps"]) < 1e-6, name + ": producer bandwidth matches raw writes")
            if row["traced"]:
                maps = {}
                for line in (directory / (row["name"]+"-bpf.jsonl")).read_text().splitlines():
                    if line.strip():
                        entry = json.loads(line)
                        if entry["type"] == "map": maps.update(entry["data"])
                check(maps["@ready_ns"] < int(row["start_ns"]), name + ": probes attached before window")
                check(maps.get("@bytes",{}) == row["kernel_bytes_by_pid_socket"], name + ": exact kernel byte counters retained")
                peers = set()
                if row["attached"]:
                    peers = {line.split()[7] for line in row["socket_peers"] if f'pid={setup["viewer"]},' in line}
                    check(bool(peers), name + ": viewer peer identified")
                    viewer_inodes = {line.split()[7] for line in row["socket_peers"] if f'pid={setup["daemon"]},' in line}
                    sent_inodes = {key.split(",")[1] for key in maps.get("@bytes",{}) if key.split(",")[0] == str(setup["viewer"])}
                    check(bool(sent_inodes) and sent_inodes <= viewer_inodes, name + ": viewer sends only to identified daemon peers")
                down = sum(value for key,value in maps.get("@bytes",{}).items() if key.split(",")[0] == str(setup["daemon"]) and key.split(",")[1] in peers)
                up = sum(value for key,value in maps.get("@bytes",{}).items() if key.split(",")[0] == str(setup["viewer"])) if row["attached"] else 0
                check(abs(down/duration-row["daemon_to_viewer_Bps"]) < 1e-6 and abs(up/duration-row["viewer_to_daemon_Bps"]) < 1e-6, name + ": protocol byte totals reconcile by socket identity")
            if row["attached"] and row["modes"][row["focus"]] == "spammy":
                check(row["visible_after"]-row["visible_before"] >= duration*18, name + ": visible progress during CPU window")
                presented = read(directory / (row["name"]+"-presentation.json"))
                check(presented["presentation"]["visible_changes_per_second"] >= 12 and presented["presentation"]["max_observed_gap_ms"] <= 250, name + ": separate presentation cadence check")
                check(abs(presented["source"]-presented["visible"]) <= 3, name + ": current source visible")
expected = int(plan["arguments"]["repeats"]) * sum(8 if int(n)==32 else 7 for n in plan["arguments"]["counts"].split(","))
check(windows == expected, "all predeclared measured windows present")
details = args.output.with_name(args.output.stem + "-checks.json.gz")
value = dict(passed=all(c["passed"] for c in checks),windows=windows,checks_passed=sum(c["passed"] for c in checks),
             failed_checks=[c for c in checks if not c["passed"]],details=details.name)
args.output.parent.mkdir(parents=True,exist_ok=True)
with gzip.open(details,"wt") as f:
    json.dump(checks,f)
args.output.write_text(json.dumps(value,indent=2)+"\n")
print(json.dumps({k:v for k,v in value.items() if k != "checks"}))
if not value["passed"]:
    print(json.dumps([c for c in checks if not c["passed"]],indent=2))
    raise SystemExit(1)
