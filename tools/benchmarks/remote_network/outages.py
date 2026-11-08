#!/usr/bin/env python3
"""Compare recovery or throughput in isolated labs, rotating CPU sets each round."""
import argparse
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("before")
    parser.add_argument("after")
    parser.add_argument("herdr")
    parser.add_argument("output")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--cpu-sets", default="32-39;48-55;64-71")
    parser.add_argument("--cases", default="blackhole3,blackhole15,blackhole35,blackhole60")
    parser.add_argument("--suite", choices=["faults", "stream", "sleep"], default="faults")
    parser.add_argument("--stream-cases", default="dense:unlimited,dense:1mbit,dense:256kbit,dense:64kbit,sparse:64kbit")
    parser.add_argument("--stream-rtt", type=int, default=120)
    parser.add_argument("--stream-seconds", type=int, default=30)
    parser.add_argument("--fault-kind", choices=["sparse", "dense"], default="sparse")
    parser.add_argument("--sleep-seconds", type=int, default=180)
    args = parser.parse_args()
    cpu_sets = args.cpu_sets.split(";")
    if len(cpu_sets) != 3 or args.repeats < 1:
        parser.error("Supply three disjoint CPU sets and a positive repeat count")
    def cores(spec):
        result = set()
        for item in spec.split(","):
            ends = [int(n) for n in item.split("-")]
            result.update(range(ends[0], ends[-1] + 1))
        return result
    assigned = [cores(spec) for spec in cpu_sets]
    if any(assigned[i] & assigned[j] for i in range(3) for j in range(i)):
        parser.error("CPU sets must be disjoint")
    if not set.union(*assigned) <= os.sched_getaffinity(0):
        parser.error("CPU sets include unavailable CPUs")
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    lock = open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a")
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
    (root / "plan.json").write_text(json.dumps(vars(args), indent=2) + "\n")
    writing = threading.Lock()
    children = set()
    stopped = threading.Event()
    def stop(_signal, _frame):
        stopped.set()
        with writing:
            for child in children:
                if child.poll() is None:
                    child.send_signal(signal.SIGINT)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    def record(event, **fields):
        with writing, (root / "execution.jsonl").open("a") as output:
            output.write(json.dumps({"event": event, "epoch": time.time(), **fields}) + "\n")
    def trial(label, binary, repeat, cpus):
        name = f"{label}-{repeat + 1}"
        command = [sys.executable, str(Path(__file__).with_name("run.py")),
                   "herdr" if label == "herdr" else "corgi", str(Path(binary).resolve()),
                   str(root / name), "--suite", args.suite, "--repeats", "1",
                   "--fault-cases", args.cases, "--cpus", cpus,
                   "--stream-cases", args.stream_cases, "--stream-rtt", str(args.stream_rtt),
                   "--stream-seconds", str(args.stream_seconds), "--fault-kind", args.fault_kind,
                   "--sleep-seconds", str(args.sleep_seconds)]
        record("start", name=name, command=command)
        with (root / f"{name}.log").open("w") as output:
            with writing:
                if stopped.is_set():
                    return 130
                child = subprocess.Popen(command, env=env, stdout=output, stderr=subprocess.STDOUT)
                children.add(child)
            code = child.wait()
            with writing:
                children.remove(child)
        record("exit", name=name, code=code)
        print(json.dumps({"name": name, "code": code}), flush=True)
        return code
    codes = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for repeat in range(args.repeats):
            if stopped.is_set():
                break
            futures = [pool.submit(trial, label, binary, repeat, cpu_sets[(index + repeat) % 3])
                       for index, (label, binary) in enumerate([
                           ("before", args.before), ("after", args.after), ("herdr", args.herdr)])]
            codes.extend(future.result() for future in futures)
            if any(codes):
                break
    return int(stopped.is_set() or any(codes))


if __name__ == "__main__":
    raise SystemExit(main())
