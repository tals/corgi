#!/usr/bin/env python3
"""Audit raw paired receipts, then publish the before/after comparison."""
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
parser.add_argument("--destination", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
plan = read(args.source / "plan.json")
continuations = read(args.source/"continuations.json") if (args.source/"continuations.json").exists() else []
checks, trials, groups, additional = [], [], {}, []
def check(ok, label):
    checks.append(dict(passed=bool(ok),label=label))
def dist(values):
    return dict(mean=statistics.mean(values),minimum=min(values),maximum=max(values),values=values)

for side,b in plan["builds"].items():
    check(sha(Path(b["binary"])) == b["sha256"], side+": executable unchanged")
for name,digest in plan["sources"].items():
    check(sha(root/name) == digest, "harness unchanged: "+name)
expected_cpu = {f"{a}-{s}" for a in ["attached","detached"] for s in ["idle","mixed","spammy"]} | {"attached-mixed-quiet-focus"}
expected_wire = {s+"-bandwidth" for s in expected_cpu if s.startswith("attached-")}
for trial in plan["order"]:
    candidates=[args.source/c["archive"] for c in continuations if c["name"]==trial["name"]]+[args.source/trial["name"]]
    selected={}
    for directory in candidates:
        setup,result=read(directory/"setup.json"),read(directory/"results.json")
        prefix=str(directory.relative_to(args.source))
        check(read(directory/"cleanup.json")["clean"],prefix+": cleanup")
        check(result["build"]["sha256"]==plan["builds"][trial["side"]]["sha256"],prefix+": binary identity")
        check(len(set(setup["pids"]))==trial["agents"],prefix+": distinct producers")
        check(all(p["cols"]==132 and p["rows"]==47 for p in setup["snapshot"]["panes"] if p["id"] in setup["panes"]),prefix+": identical geometry")
        for row in result["rows"]:
            if row["name"] not in selected:
                selected[row["name"]]=(row,directory,setup,result)
            else:
                additional.append(dict(**row,side=trial["side"],pair=trial["pair"],source=prefix+"/results.json"))
    check(set(selected)==expected_cpu|expected_wire,trial["name"]+": every planned scenario has a valid window")
    for row,directory,setup,result in selected.values():
        prefix=str(directory.relative_to(args.source))
        name=prefix+": "+row["name"]
        duration = (int(row["end_ns"])-int(row["start_ns"]))/1e9
        check(result["cpus"] == plan["placement"]["selection"]["cpus"].split(","),name+": same CPU placement")
        expected_modes = ["idle" if "idle" in row["name"] else "spammy" if "spammy" in row["name"] else
                          "spammy" if i < trial["agents"]//4 else "light" if i < trial["agents"]//2 else "idle"
                          for i in range(trial["agents"])]
        check(row["modes"] == expected_modes,name+": prescribed workload mix")
        check(row["traced"] == (row["name"] in expected_wire),name+": CPU and wire instrumentation separated")
        check(duration == plan["arguments"]["bandwidth_seconds" if row["traced"] else "seconds"],name+": planned duration")
        check(abs(row["seconds"]-duration)<.1 and max(row["start_jitter_ms"],row["end_jitter_ms"])<100,name+": timing within 100 ms")
        for process in ["daemon","viewer"]:
            counters = row["cpu_counters"][process]
            if counters:
                b,a = counters
                computed = 100*(a["user"]+a["system"]-b["user"]-b["system"])/row["cpu_counters"]["ticks"]/row["seconds"]
                check(a["start"]==b["start"] and abs(computed-row[process+"_cpu"]["percent"])<1e-9,name+": "+process+" CPU counters reconcile")
        producers = read(directory/(row["name"]+"-producers.json"))
        check(len(producers)==trial["agents"],name+": all producers accounted for")
        total = 0
        for i,p in enumerate(producers):
            records = p["records"]
            hz = {"idle":0,"light":2,"spammy":20}[p["mode"]]
            size = {"idle":0,"light":134,"spammy":2144}[p["mode"]]
            check(p["pid"]==setup["pids"][i] and p["mode"]==row["modes"][i],name+f": lane {i} identity/mode")
            check(all(int(row["start_ns"])<=int(r[0])<int(row["end_ns"]) and int(r[1])>=int(r[0]) for r in records),name+f": lane {i} timestamps")
            check(len(records)==p["writes"] and abs(len(records)-hz*duration)<=max(2,hz*duration*.02),name+f": lane {i} cadence")
            check(all(r[3]==size for r in records),name+f": lane {i} full writes")
            total += sum(r[3] for r in records)
        check(abs(total/duration-row["producer_Bps"])<1e-6,name+": source bytes reconcile")
        if row["traced"]:
            maps = {}
            for line in (directory/(row["name"]+"-bpf.jsonl")).read_text().splitlines():
                if line.strip():
                    entry = json.loads(line)
                    if entry["type"]=="map": maps.update(entry["data"])
            check(maps["@ready_ns"]<int(row["start_ns"]),name+": tracer ready")
            counters = maps.get("@bytes",{})
            check(counters==row["kernel_bytes_by_pid_socket"],name+": raw kernel counters retained")
            peers = lambda pid: {line.split()[7] for line in row["socket_peers"] if f"pid={pid}," in line}
            down_peers,up_peers = peers(setup["viewer"]),peers(setup["daemon"])
            check(bool(down_peers) and bool(up_peers),name+": both endpoint peers identified")
            count = lambda pid,inodes: sum(v for k,v in counters.items() if k.split(",")[0]==str(pid) and k.split(",")[1] in inodes)
            down,up = count(setup["daemon"],down_peers),count(setup["viewer"],up_peers)
            check(abs(down/duration-row["daemon_to_viewer_Bps"])<1e-6 and abs(up/duration-row["viewer_to_daemon_Bps"])<1e-6,name+": actual socket traffic reconciles")
            row["protocol_Bps"]=(down+up)/duration
        if row["attached"] and row["modes"][row["focus"]]=="spammy":
            check(row["visible_after"]-row["visible_before"]>=18*duration,name+": foreground advanced")
            p=read(directory/(row["name"]+"-presentation.json"))
            check(p["presentation"]["visible_changes_per_second"]>=12 and p["presentation"]["max_observed_gap_ms"]<=250 and abs(p["source"]-p["visible"])<=3,name+": foreground cadence and source lag")
        row.update(side=trial["side"],pair=trial["pair"],source=prefix+"/results.json",environment_flag=row["max_sibling_busy"]>.02)
        row["combined_cpu"]=row["daemon_cpu"]["percent"]+(row["viewer_cpu"]["percent"] if row["viewer_cpu"] else 0)
        trials.append(row)
        groups.setdefault((trial["agents"],row["name"]),{}).setdefault(trial["side"],[]).append(row)
long_path=args.source/"long-spammy/summary.json"
long_sample=read(long_path) if long_path.exists() else None
if long_sample:
    check(set(long_sample["results"])=={"before","after"},"both long follow-up samples complete")
    check(sha(Path(__file__).with_name("long_spammy.py"))==long_sample["plan"]["script_sha256"],"long follow-up script identity")
    for side,item in long_sample["results"].items():
        directory=(args.source/item["source"]).parent
        result=read(directory/"results.json");setup=read(directory/"setup.json")
        check(read(directory/"cleanup.json")["clean"] and not (directory/"failure.txt").exists(),side+": long sample completed")
        check(result["build"]["sha256"]==plan["builds"][side]["sha256"],side+": long sample binary")
        for row in result["rows"]:
            label=side+": long "+row["name"]
            duration=(int(row["end_ns"])-int(row["start_ns"]))/1e9
            check(duration==(60 if row["traced"] else 20),label+": duration")
            for process in ["daemon","viewer"]:
                b,a=row["cpu_counters"][process]
                value=100*(a["user"]+a["system"]-b["user"]-b["system"])/row["cpu_counters"]["ticks"]/row["seconds"]
                check(a["start"]==b["start"] and abs(value-row[process+"_cpu"]["percent"])<1e-9,label+": "+process+" CPU")
            producers=read(directory/(row["name"]+"-producers.json"))
            check(len(producers)==32,label+": 32 producers")
            total=0
            for i,p in enumerate(producers):
                check(p["pid"]==setup["pids"][i] and p["mode"]=="spammy" and abs(len(p["records"])-20*duration)<=20*duration*.02,label+f": lane {i} identity/rate")
                check(all(int(row["start_ns"])<=int(r[0])<int(row["end_ns"]) and int(r[1])>=int(r[0]) and r[3]==2144 for r in p["records"]),label+f": lane {i} full timestamped writes")
                total+=sum(r[3] for r in p["records"])
            check(abs(total/duration-row["producer_Bps"])<1e-6,label+": source bytes")
            if row["traced"]:
                maps={}
                for line in (directory/(row["name"]+"-bpf.jsonl")).read_text().splitlines():
                    if line.strip():
                        entry=json.loads(line)
                        if entry["type"]=="map":maps.update(entry["data"])
                counters=maps.get("@bytes",{})
                check(maps["@ready_ns"]<int(row["start_ns"]),label+": tracer ready")
                peers=lambda pid:{line.split()[7] for line in row["socket_peers"] if f"pid={pid}," in line}
                count=lambda pid,inodes:sum(v for k,v in counters.items() if k.split(",")[0]==str(pid) and k.split(",")[1] in inodes)
                wire=(count(setup["daemon"],peers(setup["viewer"]))+count(setup["viewer"],peers(setup["daemon"])))/duration
                check(counters==row["kernel_bytes_by_pid_socket"] and abs(wire-item["protocol_Bps"])<1e-6,label+": exact kernel totals")
calibration = read(args.calibration/"result.json")
check(calibration["passed"] and calibration["measured"]==calibration["expected"],"independent exact socket counter calibration")
check(len(trials)==len(plan["order"])*11,"every predeclared measurement retained")
evidence=args.destination/"comparison-evidence"
evidence.mkdir(parents=True,exist_ok=True)
audit=dict(followup_windows=4 if long_sample else 0,passed=all(c["passed"] for c in checks),windows=len(trials),checks_passed=sum(c["passed"] for c in checks),failed_checks=[c for c in checks if not c["passed"]])
(evidence/"audit.json").write_text(json.dumps(audit,indent=2)+"\n")
with gzip.open(evidence/"audit-checks.json.gz","wt") as f: json.dump(checks,f)
if not audit["passed"]:
    print(json.dumps(audit,indent=2)); raise SystemExit(1)
summary=[]
for (n,name),sides in sorted(groups.items()):
    record=dict(agents=n,name=name,metrics={},sources={s:[r["source"] for r in rows] for s,rows in sides.items()})
    keys=["protocol_Bps","daemon_to_viewer_Bps","viewer_to_daemon_Bps","producer_Bps","terminal_Bps"] if name.endswith("-bandwidth") else ["daemon_cpu","viewer_cpu","combined_cpu","terminal_Bps","provider_cpu_percent"]
    for key in keys:
        if key=="viewer_cpu" and name.startswith("detached-"): continue
        value=lambda r: r[key]["percent"] if key in ["daemon_cpu","viewer_cpu"] else r[key]
        b=sorted(sides["before"],key=lambda r:r["pair"]); a=sorted(sides["after"],key=lambda r:r["pair"])
        bv,av=[value(r) for r in b],[value(r) for r in a]
        bm,am=statistics.mean(bv),statistics.mean(av)
        record["metrics"][key]=dict(before=dist(bv),after=dist(av),paired_difference=dist([y-x for x,y in zip(bv,av)]),relative_change_percent=100*(am/bm-1) if bm else None)
    summary.append(record)
cadence={side:dict(hz=dist([r["presentation"]["hz"] for r in trials if r["side"]==side and r["presentation"]]),
                   max_gap_ms=max(r["presentation"]["max_gap_ms"] for r in trials if r["side"]==side and r["presentation"]))
         for side in ["before","after"]}
environment={side:dict(cpu_windows=sum(r["side"]==side and not r["traced"] for r in trials),
                       flagged_cpu_windows=sum(r["side"]==side and not r["traced"] and r["environment_flag"] for r in trials),
                       cpu_window_sibling_busy=dist([r["max_sibling_busy"] for r in trials if r["side"]==side and not r["traced"]]))
             for side in ["before","after"]}
outlier=[]
for side in ["before","after"]:
    r=next((r for r in trials if r["agents"]==32 and r["pair"]==0 and r["side"]==side and r["name"]=="attached-spammy-bandwidth"),None)
    if r is None: continue
    run=read(args.source/r["source"]);duration=(int(r["end_ns"])-int(r["start_ns"]))/1e9
    peers=lambda pid:{line.split()[7] for line in r["socket_peers"] if f"pid={pid}," in line}
    count=lambda pid,inodes:sum(v for k,v in r["kernel_writes_by_pid_socket"].items() if k.split(",")[0]==str(pid) and k.split(",")[1] in inodes)
    up=count(run["viewer"],peers(run["daemon"]));down=count(run["daemon"],peers(run["viewer"]))
    outlier.append(dict(side=side,source=r["source"],seconds=duration,downstream_writes=down,upstream_writes=up,
                        mean_upstream_bytes_per_write=r["viewer_to_daemon_Bps"]*duration/up,
                        protocol_Bps=r["protocol_Bps"],producer_Bps=r["producer_Bps"],terminal_Bps=r["terminal_Bps"]))
(evidence/"outlier.json").write_text(json.dumps(outlier,indent=2)+"\n")
document=dict(outlier=outlier,long_spammy=long_sample,analysis_policy=read(args.source/"analysis-policy.json") if (args.source/"analysis-policy.json").exists() else {"policy":"First valid window per planned scenario"}, additional_valid_windows=len(additional),continuations=continuations,cpu_unit="percent of one logical core, all process threads, user+system; differences in percentage points", bandwidth_unit="bytes/second accepted on actual viewer-daemon Unix sockets, both directions, including framing", environment=environment,cadence=cadence,schema="local-transport-comparison-v1",builds=plan["builds"],arguments=plan["arguments"],order=plan["order"],placement=plan["placement"]["selection"],rows=summary,measured_windows=len(trials),flagged_windows=sum(r["environment_flag"] for r in trials),calibration=calibration,
              notes="Two trials per build by default, ABBA order at each count. Means and individual paired differences; not confidence intervals. CPU is untraced; bandwidth is a separate traced window. First valid window per planned scenario, including valid windows in later-aborted attempts; other valid retry windows retained separately.")
(evidence/"summary.json").write_text(json.dumps(document,indent=2)+"\n")
with gzip.open(evidence/"trials.json.gz","wt") as f: json.dump(trials,f)
with gzip.open(evidence/"additional-trials.json.gz","wt") as f: json.dump(additional,f)
with tarfile.open(evidence/"raw.tar.gz","w:gz") as archive:
    for directory,prefix in [(args.source,"matrix"),(args.calibration,"calibration")]:
        for file in sorted(directory.rglob("*")):
            if file.is_file(): archive.add(file,arcname=prefix+"/"+str(file.relative_to(directory)))
    for name in plan["sources"]: archive.add(root/name,arcname="harness/"+name)
    if long_sample:
        archive.add(Path(__file__).with_name("long_spammy.py"),arcname="harness/tools/benchmarks/local_scale/long_spammy.py")
    if continuations:
        archive.add(Path(__file__).with_name("resume_compare.py"),arcname="harness/tools/benchmarks/local_scale/resume_compare.py")
get=lambda n,name,key: next(r for r in summary if r["agents"]==n and r["name"]==name)["metrics"][key]
cell=lambda m,scale=1: f'{m["before"]["mean"]/scale:.2f} → {m["after"]["mean"]/scale:.2f}'
counts=list(map(int,plan["arguments"]["counts"].split(",")))
lines=["# Local transport: before and after WebSockets","",
       "Before: `"+plan["builds"]["before"]["build"]["releaseCommit"][:8]+"` (raw streams). After: `"+plan["builds"]["after"]["build"]["releaseCommit"][:8]+"` (uncompressed WebSockets over Unix sockets). Production builds use identical Bun and native code.","",
       f'{plan["arguments"]["pairs"]} samples per build and agent count, reversing build order. Entries are **before → after** means, using the first valid window per scenario. CPU is percent of one core; traffic is actual socket **kB/s, both directions**, including framing. One visible pane.',"",
       "| Agents | Workload | Daemon CPU % | Viewer CPU % | Traffic kB/s |",
       "| ---: | --- | ---: | ---: | ---: |"]
for n in counts:
    for mix in ["idle","mixed","spammy"]:
        name="attached-"+mix; bw=get(n,name+"-bandwidth","protocol_Bps")
        lines.append(f'| {n} | {mix.capitalize()} | {cell(get(n,name,"daemon_cpu"))} | {cell(get(n,name,"viewer_cpu"))} | {cell(bw,1000)} |')
if 32 in counts:
    spread=get(32,"attached-spammy-bandwidth","protocol_Bps")["after"]
    if spread["maximum"]>spread["minimum"]*1.05:
        lines += ["", f'**32-agent spammy traffic is variable:** the two primary WebSocket samples were {spread["minimum"]/1000:.2f} and {spread["maximum"]/1000:.2f} kB/s. The higher sample remains in the mean; the longer follow-up below checks whether it persists.']
lines += ["","Mixed = 50% idle, 25% light (one row at 2 Hz), 25% spammy (16 colored lines at 20 Hz); a spammy tab is visible. Spammy = every agent produces 42.88 kB/s. Idle retains normal Corgi animation/resource work.","",
          "[Paired differences, ranges and direction splits](comparison-evidence/summary.json) · [Raw receipts and exact harness](comparison-evidence/raw.tar.gz) · [Independent audit](comparison-evidence/audit.json) · [Reproduction](comparison-playbook.md)","",
          "| Agents | Mixed, idle tab visible: kB/s | Detached daemon CPU %: idle | Mixed | Spammy |",
          "| ---: | ---: | ---: | ---: | ---: |"]
for n in counts:
    lines.append(f'| {n} | {cell(get(n,"attached-mixed-quiet-focus-bandwidth","protocol_Bps"),1000)} | '+" | ".join(cell(get(n,"detached-"+s,"daemon_cpu")) for s in ["idle","mixed","spammy"])+" |")
if continuations:
    lines += ["", f"**Repeated attempts:** {len(continuations)} attempt(s) failed checks and were rerun unchanged. Earlier valid windows remain in the main table; later retries only fill failed or missing scenarios. [Attempt and continuation records](comparison-evidence/summary.json)."]
    for c in continuations:
        lines += ["", f"- `{c['name']}`: {c['failure']}. {c['reason']}"]
lines += ["",f'CPU windows: {plan["arguments"]["seconds"]} s, without byte tracing. Separate bandwidth windows: {plan["arguments"]["bandwidth_seconds"]} s. Warmup: {plan["arguments"]["warmup"]} s. {document["flagged_windows"]}/{len(trials)} windows exceeded the predeclared 2% SMT-sibling-load flag; all remain included. Small differences need more repetitions; two observations per build do not establish statistical significance.',"",
          "Traffic differences include periodic metadata and measurement-boundary variation; the percentages do not isolate WebSocket framing overhead. Idle/quiet-tab samples are especially sensitive because their total traffic is small.","",
          "Synthetic agent output, minimal transcripts, one visible pane, no model calls. Provider CPU and terminal-emulator CPU are excluded. Startup/HTTP handshake costs are excluded. These measurements cover the local transport migration including its rollback support; they do not measure remote compression.",""]
split=next(i for i,line in enumerate(lines) if line.startswith("| Agents | Mixed, idle tab visible"))
details=["# Controls, checks, and limitations", "", *lines[split:]]
if len(outlier)==2:
    b,a=outlier
    size_term=(a["mean_upstream_bytes_per_write"]-b["mean_upstream_bytes_per_write"])*a["upstream_writes"]/a["seconds"]
    rate_term=(a["upstream_writes"]/a["seconds"]-b["upstream_writes"]/b["seconds"])*b["mean_upstream_bytes_per_write"]
    details += ["## First 32-agent spammy pair", "",
                f'Traffic: {b["protocol_Bps"]/1000:.2f} → {a["protocol_Bps"]/1000:.2f} kB/s. Producer volume: {b["producer_Bps"]:,.0f} → {a["producer_Bps"]:,.0f} bytes/s. Daemon socket writes: {b["downstream_writes"]} → {a["downstream_writes"]}; viewer socket writes: {b["upstream_writes"]} → {a["upstream_writes"]}, in {b["seconds"]:g} seconds. Average upstream bytes per write: {b["mean_upstream_bytes_per_write"]:.2f} → {a["mean_upstream_bytes_per_write"]:.2f}. These are kernel write counts, not logical frame counts.', "",
                f'Decomposing the upstream difference by mean write size and write frequency gives {size_term:.1f} bytes/s from changed mean size and {rate_term:.1f} bytes/s from changed frequency. This separates tiny per-write changes from additional output activity; it does not establish why activity changed. [Exact derivation inputs](comparison-evidence/outlier.json).', ""]
details += [("The first-valid-window rule is an explicit analysis amendment after the failures, recorded in `matrix/analysis-policy.json` in the raw archive. It prevents a later failure from removing an earlier unfavorable measurement. The original plan and continuation history are retained." if (args.source/"analysis-policy.json").exists() else "The table uses the first valid window for each planned scenario; later valid retries are retained separately."), "",
            f"{len(additional)} other valid retry windows are retained in [additional-trials.json.gz](comparison-evidence/additional-trials.json.gz). They do not replace earlier valid observations.", ""]
if long_sample:
    details += ["The 60-second follow-up uses the same unchanged builds and workload. It is one sample per build in before/after order, with separate 20-second untraced CPU windows. Its plan, full counters, and producer receipts are under `matrix/long-spammy/` in the archive.", ""]
(args.destination/"comparison-details.md").write_text("\n".join(details))
main=lines[:split]+[f'CPU was measured without tracing; bandwidth used separate kernel-counter windows. {document["flagged_windows"]}/{len(trials)} windows crossed the host-noise flag; all valid windows are retained, with extra retries reported separately. Small differences remain uncertain on this shared host.', ""]
if continuations:
    main += [f"{len(continuations)} attempts failed validity checks and required repeats. Earlier valid windows remain in the table; the failure records are retained. [Diagnostics](comparison-details.md).", ""]
stall_files=list(args.source.glob("failures/*/stall-analysis.json"))
if stall_files:
    stalls=[w for p in stall_files for w in read(p)["writes"]]
    main += [f'A detached attempt recorded overlapping PTY-write stalls across {len(stalls)} producers: {min(w["duration_ms"] for w in stalls)/1000:.2f}–{max(w["duration_ms"] for w in stalls)/1000:.2f} s. The cause remains unresolved.', ""]
if long_sample:
    b,a=long_sample["results"]["before"],long_sample["results"]["after"]
    main += [f'**Long 32-agent spammy check (60 s): {b["protocol_Bps"]/1000:.2f} → {a["protocol_Bps"]/1000:.2f} kB/s.** This follow-up is separate from the short-window means above; the original observations are retained.', ""]
main += ["[Detached/quiet-tab controls and limitations](comparison-details.md) · [Earlier current-only results and unresolved daemon exit](CURRENT_ONLY.md)", ""]
(args.destination/"README.md").write_text("\n".join(main))
(evidence/"manifest.json").write_text(json.dumps(dict(sha256={p.name:sha(p) for p in evidence.iterdir() if p.is_file() and p.name!="manifest.json"},publisher_sha256=sha(Path(__file__))),indent=2)+"\n")
print(json.dumps(audit))
