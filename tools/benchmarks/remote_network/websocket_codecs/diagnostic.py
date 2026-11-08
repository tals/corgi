#!/usr/bin/env python3
"""Confirm negotiated SSH compression and collect controller/codec telemetry."""

import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

import argparse
import fcntl
import os
from pathlib import Path

from adaptive_run import Evaluation
from freeze_audit import instrument_ssh
from run import UID


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", choices=["corgi", "herdr"])
    parser.add_argument("binary")
    parser.add_argument("output")
    parser.add_argument("--cpus", default="0-3")
    args = parser.parse_args()
    args.panes = 4
    args.ui = args.ansi = args.calibrate = False
    args.capture = True
    args.trace = True
    args.ssh_compression = "default"
    args.stream_rtt = 300
    args.fault_kind = "sparse"
    args.suite = "diagnostic"
    lock = open(f"/tmp/corgi-cpu-benchmark-{UID}.lock", "a")
    owner = os.environ.get("CORGI_CPU_BENCHMARK_LOCK")
    if owner:
        pid, started = owner.split(":")
        assert (
            Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()[19]
            == started
        )
    else:
        fcntl.flock(lock, fcntl.LOCK_EX)
    lab = Evaluation(args)
    try:
        lab.setup()
        (lab.out / "adaptive_diagnostic.py").write_bytes(Path(__file__).read_bytes())
        lab.envs["local"]["CORGI_EVAL_CODEC_PROOF"] = str(lab.out / "codec.jsonl")
        instrument_ssh(lab)
        lab.startup(120, 0)
        lab.streaming("sparse", "1mbit", 8)
        lab.streaming("dense", "1mbit", 8)
    finally:
        lab.cleanup()


if __name__ == "__main__":
    main()
