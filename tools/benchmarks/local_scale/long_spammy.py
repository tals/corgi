#!/usr/bin/env python3
"""Follow up the 32-agent traffic outlier with a 60-second sample per build."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT=Path(__file__).resolve().parents[3]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("source",type=Path,help="Completed comparison with frozen plan.json")
args=parser.parse_args()
source=args.source.resolve()
read=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
parent=read(source/"plan.json")
with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock","a") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    output=source/"long-spammy";output.mkdir()
    plan=dict(created_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),parent_plan_sha256=sha(source/"plan.json"),
              script_sha256=sha(Path(__file__)),order=["before","after"],agents=32,cpu_seconds=20,bandwidth_seconds=60,
              warmup_seconds=5,purpose="Check persistence of the short-window traffic outlier; retain the original observation regardless of outcome.")
    (output/"plan.json").write_text(json.dumps(plan,indent=2)+"\n")
    stat=Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")",1)[1].split()
    env=dict(os.environ,CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{stat[19]}",UI_DRIVER_KEEP="1")
    summary={}
    for side in plan["order"]:
        if any(sha(Path(b["binary"]))!=b["sha256"] for b in parent["builds"].values()) or any(sha(ROOT/p)!=h for p,h in parent["sources"].items()):
            raise RuntimeError("Frozen inputs changed")
        directory=output/side
        command=["taskset","-c","0","bun",str(Path(__file__).with_name("run.ts")),
                 "--binary",parent["builds"][side]["binary"],"--out",str(directory),
                 "--agents","32","--repeat","0","--seconds","20","--warmup","5",
                 "--bandwidth-seconds","60","--trace","off","--scenarios","spammy","--attachments","attached",
                 "--cpus",parent["placement"]["selection"]["cpus"]]
        print(json.dumps(dict(starting=side,command=command)),flush=True)
        with (output/(side+".log")).open("w") as log:
            result=subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        if (directory/"setup.json").exists():
            home=Path(read(directory/"setup.json")["home"])
            receipts=directory/"retained-producers";receipts.mkdir(exist_ok=True)
            for p in home.glob("scale-*.json"):shutil.copy2(p,receipts/p.name)
            (directory/"retained-home.json").write_text(json.dumps(dict(path=str(home),exists=home.exists()))+"\n")
        if result.returncode:raise RuntimeError(f"Failed {side}; all evidence retained")
        rows=read(directory/"results.json")["rows"]
        cpu=next(r for r in rows if not r["traced"]);wire=next(r for r in rows if r["traced"])
        summary[side]=dict(daemon_cpu=cpu["daemon_cpu"]["percent"],viewer_cpu=cpu["viewer_cpu"]["percent"],
                           protocol_Bps=wire["daemon_to_viewer_Bps"]+wire["viewer_to_daemon_Bps"],
                           producer_Bps=wire["producer_Bps"],presentation=wire["presentation"],
                           source=str((directory/"results.json").relative_to(source)))
        (output/"summary.json").write_text(json.dumps(dict(plan=plan,results=summary),indent=2)+"\n")
        print(json.dumps(dict(completed=side,**summary[side])),flush=True)
