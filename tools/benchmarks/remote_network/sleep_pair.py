#!/usr/bin/env python3
"""Reserve the benchmark slot, then suspend two isolated clients concurrently."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("corgi")
parser.add_argument("herdr")
parser.add_argument("output")
parser.add_argument("--seconds", default="180,660")
args = parser.parse_args()
root = Path(args.output).resolve()
root.mkdir(parents=True, exist_ok=True)
with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a") as lock:
    owner = os.environ.get("CORGI_CPU_BENCHMARK_LOCK")
    if owner:
        pid, started = owner.split(":")
        stat = Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()
        if stat[19] != started:
            raise RuntimeError("Stale benchmark lock owner")
    else:
        print("Waiting for the shared benchmark slot", flush=True)
        fcntl.flock(lock, fcntl.LOCK_EX)
        started = Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()[19]
        owner = f"{os.getpid()}:{started}"
    env = dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=owner)
    for seconds in map(int, args.seconds.split(",")):
        jobs = []
        for product, cpus in [("corgi", "32-39"), ("herdr", "48-55")]:
            output = root / f"sleep-{seconds}-{product}"
            command = [sys.executable, str(Path(__file__).with_name("run.py")), product, getattr(args, product), str(output),
                       "--suite", "sleep", "--sleep-seconds", str(seconds), "--cpus", cpus]
            log = output.with_suffix(".log").open("w")
            job = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
            jobs.append((job, log, command))
        for job, log, command in jobs:
            status = job.wait()
            log.close()
            with (root / "execution.jsonl").open("a") as manifest:
                manifest.write(json.dumps({"at": time.time(), "command": command, "status": status}) + "\n")
            print(json.dumps({"product": command[2], "seconds": seconds, "status": status}), flush=True)
