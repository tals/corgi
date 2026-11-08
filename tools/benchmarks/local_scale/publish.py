#!/usr/bin/env python3
"""Reduce completed local-scale trials and preserve the measured evidence."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import statistics
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("--calibration", type=Path, required=True)
parser.add_argument("--destination", type=Path, default=Path(__file__).parent)
args = parser.parse_args()
args.source = args.source.resolve()
evidence = args.destination / "evidence"
evidence.mkdir(parents=True, exist_ok=True)
plan = json.loads((args.source / "plan.json").read_text())
continuation = json.loads((args.source / "continuation.json").read_text()) if (args.source / "continuation.json").exists() else None
groups, trials = {}, []
counts = [int(n) for n in plan["arguments"]["counts"].split(",")]
repeats = int(plan["arguments"]["repeats"])
for repeat in range(repeats):
    for count in counts:
        directory = args.source / f"r{repeat}-{count}"
        value = json.loads((directory / "results.json").read_text())
        if value["build"]["sha256"] != plan["binary_sha256"] or not json.loads((directory / "cleanup.json").read_text())["clean"]:
            raise ValueError("Build/cleanup mismatch")
        expected = {f"{attached}-{mix}" for attached in ["attached", "detached"] for mix in ["idle", "mixed", "spammy"]}
        expected.add("attached-mixed-quiet-focus")
        if count == 32:
            expected.add("attached-spammy-untraced")
        if {r["name"] for r in value["rows"]} != expected:
            raise ValueError("Missing phases")
        for row in value["rows"]:
            row["source"] = f"r{repeat}-{count}/results.json"
            row["protocol_Bps"] = None if not row["traced"] else row["daemon_to_viewer_Bps"] + row["viewer_to_daemon_Bps"]
            row["environment_flag"] = row["max_sibling_busy"] > .02
            trials.append(row)
            groups.setdefault((count,row["name"]),[]).append(row)

def distribution(values):
    values = [v for v in values if v is not None]
    return dict(median=statistics.median(values),minimum=min(values),maximum=max(values)) if values else None

summary = []
for (count,name), rows in sorted(groups.items()):
    row = dict(agents=count,name=name,trials=len(rows),environment_flags=sum(r["environment_flag"] for r in rows),
               sources=[r["source"] for r in rows])
    for key in ["daemon_cpu","viewer_cpu"]:
        row[key] = distribution([r[key]["percent"] if r[key] else None for r in rows])
    row["daemon_waited_child_cpu"] = distribution([r["daemon_cpu"]["waited_children_percent"] for r in rows])
    for key in ["protocol_Bps","daemon_to_viewer_Bps","viewer_to_daemon_Bps","daemon_other_unix_Bps", "terminal_Bps","producer_Bps", "provider_cpu_percent", "max_sibling_busy"]:
        row[key] = distribution([r[key] for r in rows])
    row["presented_hz"] = distribution([r["presentation"]["hz"] if r["presentation"] else None for r in rows])
    summary.append(row)

controls = []
for repeat in range(repeats):
    pair = [next(r for r in trials if r["agents"] == 32 and r["repeat"] == repeat and r["name"] == name)
            for name in ["attached-spammy", "attached-spammy-untraced"]]
    controls.append(dict(repeat=repeat, traced_first=repeat % 2 == 0,
                         traced_daemon=pair[0]["daemon_cpu"]["percent"], untraced_daemon=pair[1]["daemon_cpu"]["percent"],
                         traced_viewer=pair[0]["viewer_cpu"]["percent"], untraced_viewer=pair[1]["viewer_cpu"]["percent"],
                         daemon_difference_points=pair[0]["daemon_cpu"]["percent"]-pair[1]["daemon_cpu"]["percent"],
                         viewer_difference_points=pair[0]["viewer_cpu"]["percent"]-pair[1]["viewer_cpu"]["percent"]))
calibration = json.loads((args.calibration / "result.json").read_text())
if not calibration["passed"]:
    raise ValueError("Counter calibration failed")
plan_record = {k:v for k,v in plan.items() if k != "placement"}
plan_record["placement"] = {k:plan["placement"][k] for k in ["selection","criteria","started_at","requested_seconds"]}
plan_record["complete_plan"] = {"archive":"raw.tar.gz","path":"matrix/plan.json","sha256":hashlib.sha256((args.source / "plan.json").read_bytes()).hexdigest()}
document = dict(schema="local-scale-v1",plan=plan_record,rows=summary,tracing_controls=controls,
                failed_trial=continuation,
                calibration=calibration,measured_windows=len(trials),
                environment={"cpu":value["cpu"],"kernel":value["platform"],"cpus":value["cpus"],"bun":plan["build"]["bunVersion"]},
                flagged_windows=sum(r["environment_flag"] for r in trials),
                cpu_unit="percent of one logical core; all process threads; user+system",
                bandwidth_unit="bytes/second; sum of both directions of the actual viewer-daemon Unix socket, including uncompressed WS framing",
                notes="Every successful planned trial retained; any aborted attempt is archived separately and excluded. Repeated windows are characterization, not confidence intervals. No Herdr or pre-WS comparison is claimed.")
(evidence / "summary.json").write_text(json.dumps(document,indent=2)+"\n")
with gzip.open(evidence / "trials.json.gz","wt") as f:
    json.dump(trials,f)
with tarfile.open(evidence / "raw.tar.gz","w:gz") as archive:
    for file in sorted(args.source.rglob("*")):
        if file.is_file(): archive.add(file,arcname="matrix/"+str(file.relative_to(args.source)))
    for file in sorted(args.calibration.rglob("*")):
        if file.is_file(): archive.add(file,arcname="calibration/"+str(file.relative_to(args.calibration)))

get = lambda n,s: next(r for r in summary if r["agents"] == n and r["name"] == s)
med = lambda row,key: row[key]["median"]
lines = ["# Local daemon: bandwidth and CPU at 4, 8, and 32 agents", "",
         "Production Corgi at `"+plan["head"][:8]+"`, uncompressed WS over Unix sockets. One viewer, one visible pane; other agents remain running in background tabs.", "",
         "Three-trial medians. CPU is **percent of one core** (100% = one fully occupied logical core), including every thread. Traffic is **kB/s, both directions combined**, including WS framing. Provider/inference CPU is excluded.", "",
         "| Agents | Mix | Daemon CPU | Viewer CPU | Viewer↔daemon | Daemon CPU, detached |",
         "| ---: | --- | ---: | ---: | ---: | ---: |"]
for count in counts:
    for mix in ["idle","mixed","spammy"]:
        r = get(count,"attached-"+mix); d = get(count,"detached-"+mix)
        flag = "†" if r["environment_flags"] else ""
        detached_flag = "†" if d["environment_flags"] else ""
        lines.append(f'| {count} | {mix.capitalize()}{flag} | {med(r,"daemon_cpu"):.2f}% | {med(r,"viewer_cpu"):.2f}% | {med(r,"protocol_Bps")/1000:.2f} | {med(d,"daemon_cpu"):.2f}%{detached_flag} |')
lines += ["", "**Mixed = half idle, one quarter light, one quarter spammy.** Light is one row at 2 Hz. Spammy is 16 colored lines per burst at 20 Hz (320 lines/s, 42.88 kB/s per agent). The mixed rows above focus a spammy tab. All-idle agents emit zero terminal output; Corgi's normal animation/resource work stays enabled.", "",
          "**Hidden output is much cheaper on the wire.** With the same mixed agents running but an idle foreground tab, traffic is " + ", ".join(f'**{med(get(n,"attached-mixed-quiet-focus"),"protocol_Bps")/1000:.2f} kB/s at {n} agents**' for n in counts) + ". Detached viewers send/receive zero bytes; internal worker notifications are counted separately.", "",
          "[Trial medians, ranges, direction splits and CPU controls](evidence/summary.json) · [All measured windows](evidence/trials.json.gz) · [Raw kernel/producer/presentation evidence](evidence/raw.tar.gz) · [Reproduction playbook](playbook.md)", "",
          "## Measurement limits", "",
          f'Each window is {plan["arguments"]["seconds"]} seconds after {plan["arguments"]["warmup"]} seconds warmup; three trials rotate count/workload order. Host: {document["environment"]["cpu"]}, Linux, CPUs `{plan["placement"]["selection"]["cpus"]}`. These are host-specific workload measurements, not a comparison with Herdr or the previous transport.', "",
          f'† {document["flagged_windows"]} of {document["measured_windows"]} successful windows exceeded the predeclared 2% SMT-sibling busy flag; all remain included. Ranges and individual flags are in the evidence. Minimal provider transcripts and non-Git projects omit inference, growing conversation histories, bound Codex app-server polling and repository work. Waited-child CPU is recorded separately, not included in daemon CPU, because Linux can charge earlier child work at reap time.', "",
          "Kernel counters were independently checked against exact AF_UNIX transfers: **8,260,182 bytes in each direction, exact match**. Viewer peers are identified by socket inode; no proxy or application patch is used. The 32-agent spammy case also alternates adjacent traced/untraced CPU windows; those pairs are retained in `tracing_controls` in the summary. Startup/HTTP negotiation is excluded.", ""]
traced_row = get(32,"attached-spammy")
untraced_row = get(32,"attached-spammy-untraced")
lines += [f'In that CPU control, traced daemon/viewer medians were **{med(traced_row,"daemon_cpu"):.2f}% / {med(traced_row,"viewer_cpu"):.2f}%**, versus **{med(untraced_row,"daemon_cpu"):.2f}% / {med(untraced_row,"viewer_cpu"):.2f}%** without tracing. Paired differences and trial ranges are in the summary; the main table consistently uses the traced windows.', "",
          f'The largest waited-child charge was **{max(r["daemon_cpu"]["waited_children_percent"] for r in trials):.2f} percentage points** of one core. That delayed accounting is not an exact contemporaneous helper-process total.', ""]
if continuation:
    lines[4:4] = ["**Reliability finding:** the daemon exited unexpectedly during one original 32-agent trial. The cause is unresolved; its initial cleanup removed the daemon log. A full rerun passed with log retention enabled. The aborted attempt is archived under `matrix/failures/` and excluded from the table; [the summary](evidence/summary.json) records the replacement and continuation.", ""]
split = lines.index("## Measurement limits")
(args.destination / "details.md").write_text("\n".join(["# Measurement checks and limits", "", *lines[split+2:]]))
lines = lines[:split] + [
    f'† {document["flagged_windows"]}/{document["measured_windows"]} windows crossed the host-noise flag; all completed windows remain included. [Ranges, tracing controls and accounting limits](details.md).', "",
    f'Without tracing, the 32-spammy-agent CPU medians were **{med(untraced_row,"daemon_cpu"):.2f}% daemon + {med(untraced_row,"viewer_cpu"):.2f}% viewer**. The table consistently uses traced windows.', "",
    "These are synthetic terminal workloads with minimal provider transcripts. Growing conversation histories, real model/provider integration work, multiple visible panes and terminal-emulator CPU are outside this measurement. [Exact workload and playbook](playbook.md).", "",
    "[Independent receipt audit](evidence/audit.json) checks the kernel totals, producer output and visible progress.", ""]
(args.destination / "README.md").write_text("\n".join(lines))
files = [evidence / "summary.json",evidence / "trials.json.gz",evidence / "raw.tar.gz"]
if (evidence / "audit.json").exists(): files.append(evidence / "audit.json")
if (evidence / "audit-checks.json.gz").exists(): files.append(evidence / "audit-checks.json.gz")
(evidence / "manifest.json").write_text(json.dumps({"sha256":{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
    "publisher_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+"\n")
print(json.dumps({"windows":len(trials),"summary_rows":len(summary),"flags":document["flagged_windows"]}))
