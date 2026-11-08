#!/usr/bin/env python3
"""Fresh-layout startup, higher cadence and uninterrupted bandwidth transitions."""

import argparse
import fcntl
import os
import time
import traceback

from adaptive_run import Evaluation
from run import UID


class Extra(Evaluation):
    def mode(self, kind="sparse", hz=None):
        super().mode(kind, self.args.hz if hz is None else hz)

    def transition(self):
        view = self.fresh_viewer()
        self.mode("dense")
        time.sleep(2)
        for phase, rate, duration in [
            ("before-cap", "1mbit", 10),
            ("capped", "64kbit", 20),
            ("after-cap", "1mbit", 10),
        ]:
            self.shape(rtt=120, rate=rate)
            start = self.event("transition", phase=phase, rate=rate)
            initial = view.latest.get("atlas")
            first = len(view.events)
            stem = "transition-" + phase
            self.network_snapshot(stem + "-start")
            probes = []
            for i in range(3):
                token = f"STEP{phase.replace('-', '')}P{i}"
                sent = view.input(token + "\r")
                probes.append({"token": token, "sent": sent})
                time.sleep(max(0, start + duration * (i + 1) / 3 - time.monotonic()))
            end = time.monotonic()
            self.network_snapshot(stem + "-end")
            frames = [
                e
                for e in view.events[first:]
                if e["event"] == "frame"
                and e["machine"] == "atlas"
                and start <= e["at"] <= end
            ]
            for probe in probes:
                echo = next(
                    (
                        e
                        for e in frames
                        if e["ack"] == probe["token"] and e["at"] >= probe["sent"]
                    ),
                    None,
                )
                probe.update(
                    ok=bool(echo), seconds=echo["at"] - probe["sent"] if echo else None
                )
            fresh = next(
                (
                    e
                    for e in frames
                    if e["source"] >= start and e["at"] - e["source"] < 0.5
                ),
                None,
            )
            self.record(
                {
                    "case": "transition",
                    "phase": phase,
                    "kind": "dense",
                    "rate": rate,
                    "rtt_ms": 120,
                    "start": start,
                    "end": end,
                    "initial_frame": initial,
                    "snapshot_prefix": stem,
                    "frames": len(frames),
                    "frame_times": [e["at"] for e in frames],
                    "frame_sources": [e["source"] for e in frames],
                    "frame_ages": [e["at"] - e["source"] for e in frames],
                    "probes": probes,
                    "fresh_seconds": fresh["at"] - start if fresh else None,
                    "producers": self.producers(),
                }
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", choices=["corgi", "herdr"])
    parser.add_argument("binary")
    parser.add_argument("output")
    parser.add_argument(
        "--suite", choices=["cold-ui", "cadence", "transition"], required=True
    )
    parser.add_argument("--cpus", default="200-203")
    args = parser.parse_args()
    args.ui = args.suite == "cold-ui"
    args.hz = 60 if args.suite == "cadence" else 20
    args.panes = 4
    args.ansi = args.capture = args.calibrate = args.trace = False
    args.ssh_compression = "default"
    args.stream_rtt = 300
    args.fault_kind = "sparse"
    lock = open(f"/tmp/corgi-cpu-benchmark-{UID}.lock", "a")
    owner = os.environ.get("CORGI_CPU_BENCHMARK_LOCK")
    if owner:
        from pathlib import Path

        pid, started = owner.split(":")
        assert (
            Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()[19]
            == started
        )
    else:
        fcntl.flock(lock, fcntl.LOCK_EX)
    lab = Extra(args)
    try:
        lab.setup()
        lab.startup(120, 0)
        if args.suite == "cadence":
            lab.streaming("sparse", "1mbit", 30)
            lab.streaming("dense", "1mbit", 30)
        elif args.suite == "transition":
            lab.transition()
    except BaseException:
        (lab.out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        lab.cleanup()


if __name__ == "__main__":
    main()
