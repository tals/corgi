#!/usr/bin/env python3
"""Recheck a candidate, overlapping long freezes on separate CPU sets."""
import argparse
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("binary")
parser.add_argument("output")
parser.add_argument("--repeats", type=int, default=3)
parser.add_argument("--cpus", default="32-39")
parser.add_argument("--sleep-seconds", default="180,660")
parser.add_argument("--sleep-cpus", default="48-55,64-71")
parser.add_argument("--herdr", help="Optional one-round control with the corrected producer")
args = parser.parse_args()
root = Path(args.output).resolve()
root.mkdir(parents=True, exist_ok=False)
lock = open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a")
print("Waiting for the shared benchmark slot", flush=True)
fcntl.flock(lock, fcntl.LOCK_EX)
started = Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()[19]
env = dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{started}")
writing = threading.Lock()


def trial(name, suite, cpus, *extra, product="corgi", binary=args.binary):
    command = [sys.executable, str(Path(__file__).with_name("run.py")), product, binary,
               str(root / name), "--suite", suite, "--repeats", "1", "--cpus", cpus, *extra]
    def record(event, **fields):
        with writing, (root / "execution.jsonl").open("a") as output:
            output.write(json.dumps({"event": event, "at": time.time(), "name": name, **fields}) + "\n")
    record("start", command=command)
    start = time.monotonic()
    with (root / f"{name}.log").open("w") as output:
        result = subprocess.run(command, env=env, stdout=output, stderr=subprocess.STDOUT)
    record("exit", code=result.returncode, seconds=time.monotonic() - start)
    print(json.dumps({"name": name, "code": result.returncode}), flush=True)
    return result.returncode


seconds = list(filter(None, args.sleep_seconds.split(",")))
cpus = args.sleep_cpus.split(",")
if len(seconds) > len(cpus):
    raise ValueError("Supply a separate CPU set for each simultaneous freeze")
codes = []
with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(seconds))) as pool:
    freezes = [pool.submit(trial, f"sleep-{duration}-corgi", "sleep", cpu, "--sleep-seconds", duration)
               for duration, cpu in zip(seconds, cpus)]
    for repeat in range(1, args.repeats + 1):
        for suite in ["stream", "startup", "faults"]:
            extra = ["--calibrate"] if repeat == 1 and suite == "startup" else []
            codes.append(trial(f"{suite}-{repeat}-corgi", suite, args.cpus, *extra))
    if args.herdr:
        codes.append(trial("stream-control-herdr", "stream", args.cpus, product="herdr", binary=args.herdr))
    codes.extend(future.result() for future in freezes)
raise SystemExit(any(codes))
