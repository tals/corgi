#!/usr/bin/env python3
"""Run alternating product blocks; retain failed attempts and exact commands."""
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
parser.add_argument("--rounds", type=int, default=3)
parser.add_argument("--start-round", type=int, default=1)
parser.add_argument("--suites", default="startup,faults,stream")
args = parser.parse_args()
root = Path(args.output).resolve()
root.mkdir(parents=True, exist_ok=True)
manifest = root / "execution.jsonl"
lock = open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a")
print("Waiting for the shared benchmark slot", flush=True)
fcntl.flock(lock, fcntl.LOCK_EX)
started = Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()[19]
env = dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{started}")
for repeat in range(args.start_round - 1, args.start_round - 1 + args.rounds):
    for index, suite in enumerate(args.suites.split(",")):
        order = ["corgi", "herdr"] if (repeat + index) % 2 == 0 else ["herdr", "corgi"]
        for product in order:
            out = root / f"{suite}-{repeat + 1}-{product}"
            command = [sys.executable, str(Path(__file__).with_name("run.py")), product, getattr(args, product), str(out), "--suite", suite, "--repeats", "1"]
            if repeat == 0 and index == 0 and product == "corgi":
                command.append("--calibrate")
            if out.exists():
                raise RuntimeError(f"Refusing to reuse {out}")
            with out.with_suffix(".log").open("w") as log, manifest.open("a", buffering=1) as record:
                start = time.time()
                record.write(json.dumps({"event": "start", "at": start, "command": command}) + "\n")
                result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
                record.write(json.dumps({"event": "exit", "at": time.time(), "seconds": time.time() - start, "code": result.returncode, "output": str(out)}) + "\n")
                print(json.dumps({"output": str(out), "code": result.returncode}), flush=True)
