#!/usr/bin/env python3
"""Capture an unchanged Corgi/Herdr bridge with strace in a private network lab."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from types import SimpleNamespace
from run import Lab, UID

parser = argparse.ArgumentParser()
parser.add_argument("binary")
parser.add_argument("output")
parser.add_argument("--kind", choices=["sparse", "dense"], default="sparse")
parser.add_argument("--product", choices=["corgi", "herdr"], default="corgi")
parser.add_argument("--seconds", type=int, default=12)
parser.add_argument("--cpus", default="32-39")
args = parser.parse_args()
if args.seconds <= 0:
    parser.error("--seconds must be positive")
lock = open(f"/tmp/corgi-cpu-benchmark-{UID}.lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
config = SimpleNamespace(
    product=args.product,
    binary=args.binary,
    output=args.output,
    suite="stream",
    repeats=1,
    panes=4,
    cpus=args.cpus,
    sleep_seconds=180,
    ansi=False,
    trace=False,
    capture=False,
    fault_cases="",
    fault_kind="sparse",
    calibrate=False,
    rtts="120",
    ssh_compression="default",
    stream_cases=f"{args.kind}:1mbit",
    stream_rtt=120,
    stream_seconds=args.seconds,
)
lab = Lab(config)
try:
    lab.setup()
    wrapper = lab.root / "local/bin/ssh"
    wrapper.write_text(
        wrapper.read_text().replace(
            "/usr/bin/ssh -F",
            "/usr/bin/ssh -vv -E "
            + shlex.quote(str(lab.out / "ssh-debug.log"))
            + " -F",
        )
    )
    lab.fresh_viewer()
    lab.mode(args.kind)
    lab.shape(rate="1mbit")
    time.sleep(4)
    bridges = []
    for pid in lab.pids("atlas"):
        try:
            argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError):
            continue
        if (
            Path(os.fsdecode(argv[0])).name == "corgi-remote-bridge"
            or b"remote-client-bridge" in argv
        ):
            bridges.append({"pid": pid, "argv": [os.fsdecode(a) for a in argv if a]})
    assert bridges, "No remote bridge to trace"
    (lab.out / "bridges.json").write_text(json.dumps(bridges, indent=2) + "\n")
    lab.network_snapshot("wire-start")
    start = lab.event("wire_capture_start", bridges=bridges, seconds=args.seconds)
    command = [
        "sudo",
        "-n",
        "timeout",
        "--signal=INT",
        str(args.seconds),
        "strace",
        "-ff",
        "-ttt",
        "-xx",
        "-s",
        "262144",
        "-e",
        "trace=read,write",
        "-o",
        str(lab.out / "wire"),
    ]
    for b in bridges:
        command += ["-p", str(b["pid"])]
    with (lab.out / "strace.log").open("w") as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode not in [0, 124]:
        raise RuntimeError(f"strace failed: {result.returncode}")
    end = lab.event("wire_capture_end")
    lab.network_snapshot("wire-end")
    lab.record(
        {
            "case": "wire_capture",
            "kind": args.kind,
            "start": start,
            "end": end,
            "producers": lab.producers(),
        }
    )
finally:
    lab.cleanup()
