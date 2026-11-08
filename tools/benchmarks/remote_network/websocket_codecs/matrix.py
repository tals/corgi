#!/usr/bin/env python3
"""Compare plain, zstd and native-deflate WebSocket Corgi against stock Herdr."""

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent.parent

SUITES = {
    "stream-600-low": [
        "--suite",
        "stream",
        "--stream-rtt",
        "600",
        "--stream-cases",
        "dense:64kbit",
    ],
    "cold-ui": ["--suite", "cold-ui"],
    "cadence": ["--suite", "cadence"],
    "transition": ["--suite", "transition"],
    "stream-120": [
        "--suite",
        "stream",
        "--stream-cases",
        "sparse:1mbit,dense:1mbit,dense:256kbit,dense:64kbit,sparse:64kbit,loss",
    ],
    "stream-300": [
        "--suite",
        "stream",
        "--stream-rtt",
        "300",
        "--stream-cases",
        "sparse:1mbit,dense:1mbit,dense:64kbit",
    ],
    "stream-600": [
        "--suite",
        "stream",
        "--stream-rtt",
        "600",
        "--stream-cases",
        "sparse:1mbit,dense:1mbit",
    ],
    "stream-20": [
        "--suite",
        "stream",
        "--stream-rtt",
        "20",
        "--stream-cases",
        "sparse:unlimited,dense:unlimited",
    ],
    "faults-sparse": [
        "--suite",
        "faults",
        "--fault-cases",
        "tcp_reset,blackhole3,blackhole35,downstream15,isolated30",
    ],
    "faults-dense": [
        "--suite",
        "faults",
        "--fault-kind",
        "dense",
        "--fault-cases",
        "blackhole3,blackhole35",
    ],
    "startup": ["--suite", "startup"],
    "navigation": ["--suite", "navigation", "--rtts", "20,120,300"],
    "sleep": ["--suite", "sleep"],
    "sleep-clean": ["--suite", "sleep", "--sleep-control", "no-pending-input"],
}


SUITES.pop("stream-300")
SUITES["accounting-cadence"] = SUITES["cadence"]
SUITES["accounting-stream-600-low"] = SUITES["stream-600-low"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before")
    parser.add_argument("after")
    parser.add_argument("control")
    parser.add_argument("herdr")
    parser.add_argument("output")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--suites", default=",".join(SUITES))
    parser.add_argument("--cpu-start", type=int, default=8)
    parser.add_argument("--cpus-per-lab", type=int, default=2)
    parser.add_argument("--zstd-raw", required=True)
    parser.add_argument("--stream-seconds", type=int, default=30)
    args = parser.parse_args()
    suites = args.suites.split(",")
    if any(s not in SUITES for s in suites) or args.repeats < 1:
        parser.error("Unknown suite or invalid repeat count")
    width = 4 * args.cpus_per_lab
    required = set(range(args.cpu_start, args.cpu_start + width * len(suites)))
    if not required <= os.sched_getaffinity(0):
        parser.error("CPU allocation exceeds available CPUs")
    topology = [
        list(map(int, line.split(",")))
        for line in subprocess.check_output(
            ["lscpu", "-p=CPU,CORE,SOCKET"], text=True
        ).splitlines()
        if not line.startswith("#")
    ]
    physical = [(core, socket) for cpu, core, socket in topology if cpu in required]
    if len(set(physical)) != len(required):
        parser.error("CPU allocation shares physical cores through SMT")
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    lock = open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a")
    owner = os.environ.get("CORGI_CPU_BENCHMARK_LOCK")
    if owner:
        pid, started = owner.split(":")
        actual = (
            Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()[19]
        )
        if actual != started:
            raise RuntimeError("Stale benchmark lock owner")
    else:
        print("Waiting for shared benchmark slot", flush=True)
        fcntl.flock(lock, fcntl.LOCK_EX)
        start = (
            Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()[19]
        )
        owner = f"{os.getpid()}:{start}"
    env = dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=owner)
    (root / "cpu-topology.json").write_text(json.dumps(topology) + "\n")
    (root / "plan.json").write_text(
        json.dumps(
            {**vars(args), "suite_arguments": {s: SUITES[s] for s in suites}}, indent=2
        )
        + "\n"
    )
    source = root / "harness"
    source.mkdir()
    hashes = {}
    for name in (
        "adaptive_matrix.py",
        "adaptive_run.py",
        "adaptive_extra.py",
        "freeze_audit.py",
        "run.py",
        "summarize.py",
        "observe.ts",
        "workload.py",
    ):
        data = (HERE / name).read_bytes()
        (source / name).write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    (root / "harness.json").write_text(json.dumps(hashes, indent=2) + "\n")
    for script in (
        "matrix.py",
        "prepare.py",
        "adapter.ts",
        "inspect.ts",
        "diagnostic.py",
    ):
        (source / script).write_bytes(Path(__file__).with_name(script).read_bytes())
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
            output.write(
                json.dumps({"event": event, "epoch": time.time(), **fields}) + "\n"
            )

    def trial(suite, label, repeat, cpus):
        product = "herdr" if label == "herdr" else "corgi"
        name = f"{label}-{repeat + 1}"
        target = root / suite
        target.mkdir(exist_ok=True)
        binary = str(Path(getattr(args, label)).resolve())
        base_suite = suite.removeprefix("accounting-")
        if suite.startswith("accounting-") and label == "after":
            binary = str(Path(args.zstd_raw).resolve())
        extra = base_suite in ("cold-ui", "cadence", "transition")
        command = [
            sys.executable,
            str(HERE / ("adaptive_extra.py" if extra else "adaptive_run.py")),
            product,
            binary,
            str(target / name),
            "--cpus",
            cpus,
            *([] if extra else ["--stream-seconds", str(args.stream_seconds)]),
            *SUITES[suite],
        ]
        record("start", suite=suite, name=name, command=command)
        with (target / f"{name}.log").open("w") as output:
            with writing:
                if stopped.is_set():
                    return 130
                child = subprocess.Popen(
                    command, env=env, stdout=output, stderr=subprocess.STDOUT
                )
                children.add(child)
            code = child.wait()
            with writing:
                children.discard(child)
        record("exit", suite=suite, name=name, code=code)
        print(f"{suite}/{name}: exit {code}", flush=True)
        return code

    def suite_run(index, suite):
        labels = ["before", "after", "control", "herdr"]
        codes = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(labels)) as pool:
            for repeat in range(args.repeats):
                if stopped.is_set():
                    break
                jobs = []
                for i, label in enumerate(labels):
                    first = (
                        args.cpu_start
                        + index * width
                        + ((i + repeat) % len(labels)) * args.cpus_per_lab
                    )
                    jobs.append(
                        pool.submit(
                            trial,
                            suite,
                            label,
                            repeat,
                            f"{first}-{first + args.cpus_per_lab - 1}",
                        )
                    )
                codes.extend(job.result() for job in jobs)
        return codes

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(suites)) as pool:
        futures = [
            pool.submit(suite_run, index, suite) for index, suite in enumerate(suites)
        ]
        codes = [code for future in futures for code in future.result()]
    (root / "exit-codes.json").write_text(json.dumps(codes) + "\n")
    return int(any(codes))


if __name__ == "__main__":
    sys.exit(main())
