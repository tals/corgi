#!/usr/bin/env python3
"""Resume the frozen comparison, archiving an invalid full attempt before retrying."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("--retry-reason", required=True)
args = parser.parse_args()
args.source=args.source.resolve()
read=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
plan=read(args.source/"plan.json")
record=args.source/"continuations.json"
continuations=read(record) if record.exists() else []
with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock","a") as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    stat=Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")",1)[1].split()
    env=dict(os.environ,CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{stat[19]}",UI_DRIVER_KEEP="1")
    for trial in plan["order"]:
        name=trial["name"]; directory=args.source/name
        if (directory/"cleanup.json").exists() and not (directory/"failure.txt").exists() and len(read(directory/"results.json")["rows"])==11:
            continue
        if any(sha(Path(b["binary"]))!=b["sha256"] for b in plan["builds"].values()) or any(sha(ROOT/p)!=digest for p,digest in plan["sources"].items()):
            raise RuntimeError("Frozen inputs changed")
        if directory.exists():
            if not (directory/"failure.txt").exists():
                raise RuntimeError("Refuse to replace an incomplete attempt without a recorded failure")
            failure=(directory/"failure.txt").open().readline().strip()
            archive=args.source/"failures"/(name+f"-attempt{1+sum(c['name']==name for c in continuations)}")
            archive.parent.mkdir(exist_ok=True)
            directory.rename(archive)
            (args.source/(name+".log")).rename(archive/"runner.log")
            continuations.append(dict(name=name,archive=str(archive.relative_to(args.source)),failure=failure,
                                      reason=args.retry_reason,utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                      resume_script_sha256=sha(Path(__file__)),plan_sha256=sha(args.source/"plan.json"),
                                      policy="Exclude entire failed attempt; rerun identical inputs. Retain stopped homes/producer receipts for diagnosis."))
            record.write_text(json.dumps(continuations,indent=2)+"\n")
        a=plan["arguments"]
        command=["taskset","-c","0","bun",str(Path(__file__).with_name("run.ts")),
                 "--binary",plan["builds"][trial["side"]]["binary"],"--out",str(directory),
                 "--agents",str(trial["agents"]),"--repeat",str(trial["pair"]),
                 "--seconds",str(a["seconds"]),"--warmup",str(a["warmup"]),
                 "--bandwidth-seconds",str(a["bandwidth_seconds"]),"--trace","off",
                 "--cpus",plan["placement"]["selection"]["cpus"]]
        print(json.dumps(dict(starting=name,command=command)),flush=True)
        with (args.source/(name+".log")).open("w") as log:
            result=subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        setup=read(directory/"setup.json") if (directory/"setup.json").exists() else None
        if setup:
            home=Path(setup["home"])
            saved=directory/"retained-producers";saved.mkdir(exist_ok=True)
            for receipt in home.glob("scale-*.json"): shutil.copy2(receipt,saved/receipt.name)
            (directory/"retained-home.json").write_text(json.dumps(dict(path=str(home),exists=home.exists()))+"\n")
        if result.returncode:raise RuntimeError(f"Failed {name}; stopped home and evidence preserved")
        print(json.dumps(dict(completed=name)),flush=True)
