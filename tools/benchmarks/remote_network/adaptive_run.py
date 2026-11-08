#!/usr/bin/env python3
"""Compare production transports; UI timings come only from the viewer PTY."""

import argparse
import fcntl
import json
import os
import signal
from pathlib import Path
import time
import traceback

from run import Lab, UID, dump, wait_for
from freeze_audit import freeze


class Evaluation(Lab):
    def seed(self, machine):
        super().seed(machine)
        if not self.args.ui:
            return
        snapshot = self.rpc(machine, "session.snapshot")
        if self.product == "corgi":
            tabs = snapshot["workspaces"][0]["model"]["tabs"]
            for i, tab in enumerate(tabs):
                self.action(
                    machine,
                    "tab.rename",
                    {"target": tab["id"], "name": f"UI_{machine}_{i}"},
                )
        else:
            for i, tab in enumerate(snapshot["snapshot"]["tabs"]):
                self.rpc(
                    machine,
                    "tab.rename",
                    {"tab_id": tab["tab_id"], "label": f"UI_{machine}_{i}"},
                )

    def record(self, value):
        if value["case"] == "startup" and self.args.ui and self.viewer:
            view = self.viewer
            launched = view.launch["launched"]
            clicked = next(
                (
                    e["at"]
                    for e in view.events
                    if e["event"] == "input" and e["text"].startswith("\x1b[<0;")
                ),
                None,
            )
            for name, event in [
                ("sidebar", "sidebar"),
                ("ui", "ui"),
                ("first_content", "frame"),
            ]:
                seen = next(
                    (
                        e
                        for e in view.events
                        if e["event"] == event and e.get("machine") == "atlas"
                    ),
                    None,
                )
                value[name + "_seconds"] = seen["at"] - launched if seen else None
                if clicked and name != "sidebar":
                    value["click_to_" + name + "_seconds"] = (
                        seen["at"] - clicked if seen else None
                    )
            value["first_click_seconds"] = clicked - launched if clicked else None
        super().record(value)

    def navigation(self, rtt):
        view = self.fresh_viewer()
        self.shape(rtt=rtt)
        time.sleep(2)
        for tab in [1, 2, 3, 0]:
            rows = view.screen().splitlines()
            label = f"UI_atlas_{tab}"
            x = rows[0].index(label) + len(label) // 2 + 1
            start = view.input(f"\x1b[<0;{x};1M\x1b[<0;{x};1m")
            machine = "atlas" + (str(tab) if tab else "")
            frame = wait_for(
                lambda: next(
                    (
                        e
                        for e in view.events
                        if e["event"] == "frame"
                        and e["machine"] == machine
                        and e["at"] >= start
                    ),
                    None,
                ),
                30,
            )
            self.record(
                {
                    "case": "navigation",
                    "rtt_ms": rtt,
                    "tab": tab,
                    "first_content_seconds": frame["at"] - start,
                    "start": start,
                }
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", choices=["corgi", "herdr"])
    parser.add_argument("binary")
    parser.add_argument("output")
    parser.add_argument(
        "--suite",
        choices=["stream", "faults", "startup", "sleep", "navigation"],
        default="stream",
    )
    parser.add_argument("--cpus", default="32-35")
    parser.add_argument("--stream-rtt", type=int, default=120)
    parser.add_argument("--stream-seconds", type=int, default=30)
    parser.add_argument(
        "--stream-cases", default="sparse:1mbit,dense:1mbit,dense:64kbit,sparse:64kbit"
    )
    parser.add_argument("--fault-kind", choices=["sparse", "dense"], default="sparse")
    parser.add_argument(
        "--fault-cases", default="blackhole3,blackhole35,downstream15,isolated30"
    )
    parser.add_argument("--rtts", default="20,120,300,600")
    parser.add_argument("--trace", action="store_true")
    parser.add_argument(
        "--sleep-control",
        choices=["original", "no-pending-input", "transport-survives"],
        default="original",
    )
    args = parser.parse_args()
    args.panes = 4
    args.ansi = args.capture = args.calibrate = False
    args.ssh_compression = "default"
    args.ui = args.suite in ("startup", "navigation")
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
        if args.suite == "startup":
            for rtt in map(int, args.rtts.split(",")):
                lab.startup_attempt(rtt, 0)
                lab.startup_attempt(rtt, 0, warm=True)
        else:
            lab.startup(120, 0)
        if args.suite == "stream":
            for case in args.stream_cases.split(","):
                if case == "loss":
                    lab.streaming(
                        "sparse", None, args.stream_seconds, loss=1, jitter=10
                    )
                else:
                    kind, rate = case.split(":")
                    lab.streaming(
                        kind, None if rate == "unlimited" else rate, args.stream_seconds
                    )
        elif args.suite == "faults":
            for case in args.fault_cases.split(","):
                if case == "tcp_reset":
                    lab.reset_connection()
                elif case.startswith("blackhole"):
                    lab.recover(
                        case,
                        lambda: lab.shape(loss=100),
                        int(case.removeprefix("blackhole")),
                    )
                elif case == "downstream15":
                    lab.recover(case, lambda: lab.shape(loss=100, direction="down"), 15)
                elif case == "isolated30":
                    lab.recover(case, lambda: lab.shape(loss=100), 30, isolation=True)
                else:
                    raise ValueError(case)
        elif args.suite == "sleep":
            lab.fresh_viewer()
            freeze(lab, args.sleep_control, 180)
        elif args.suite == "navigation":
            for rtt in map(int, args.rtts.split(",")):
                lab.navigation(rtt)
    except BaseException:
        (lab.out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        for pid in lab.pids("local") if "local" in lab.created else []:
            try:
                os.kill(pid, signal.SIGCONT)
            except (ProcessLookupError, PermissionError):
                pass
        lab.cleanup()


if __name__ == "__main__":
    main()
