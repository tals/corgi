#!/usr/bin/env python3
"""Audit stock Herdr's freeze recovery with external, single-variable controls."""

import argparse
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time
import traceback

from run import Lab, UID

CASES = ("original", "fresh-ssh-at-wake", "no-pending-input", "transport-survives")


def instrument_ssh(lab):
    directory = lab.out / "ssh-debug"
    directory.mkdir()
    wrapper = lab.root / "local/bin/ssh"
    config = str(lab.root / "local/home/.ssh/config")
    wrapper.write_text(
        "#!/usr/bin/python3\nimport os,sys,time,json\n"
        + f"directory={str(directory)!r}\nconfig={config!r}\n"
        + "pid=os.getpid()\nargs=sys.argv[1:]\n"
        + "with open(directory+'/starts.jsonl','a') as out: out.write(json.dumps({'pid':pid,'at':time.monotonic(),'epoch':time.time(),'args':args})+'\\n')\n"
        + "os.execv('/usr/bin/ssh',['/usr/bin/ssh','-vv','-E',directory+'/'+str(pid)+'.log','-F',config]+args)\n"
    )
    wrapper.chmod(0o700)


def freeze(lab, case, seconds):
    view = lab.viewer
    view.switch("atlas")
    lab.mode("sparse")
    before = view.echo("BEFORESLEEP")
    lab.shape(loss=100, direction="down")
    pending = None if case == "no-pending-input" else view.input("SLEEP_PENDING\r")
    time.sleep(0.3)
    for machine in ("atlas", "borealis"):
        lab.shape(machine, loss=100)
    pids = []
    # Keep diagnostic capture and root-owned ss probes running during the freeze.
    for pid in lab.pids("local"):
        try:
            proc = Path(f"/proc/{pid}")
            if proc.stat().st_uid == UID and (
                proc / "comm"
            ).read_text().strip() not in ("tcpdump", "ss", "ip", "sudo"):
                pids.append(pid)
        except FileNotFoundError:
            pass
    old_ssh = []
    for pid in pids:
        try:
            if Path(f"/proc/{pid}/comm").read_text().strip() == "ssh":
                old_ssh.append(pid)
            os.kill(pid, signal.SIGSTOP)
        except ProcessLookupError:
            pass
    start = lab.event(
        "sleep_start", seconds=seconds, stopped=pids, old_ssh=old_ssh, control=case
    )
    if case != "transport-survives":
        for machine in ("atlas", "borealis"):
            lab.admin(
                machine, "ss", "-K", "state", "established", "sport", "=", ":2222"
            )
    time.sleep(max(0, start + seconds - time.monotonic()))
    for machine in ("atlas", "borealis"):
        lab.shape(machine)
    if case == "fresh-ssh-at-wake":
        for pid in old_ssh:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        lab.event("old_client_ssh_killed", pids=old_ssh)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGCONT)
        except ProcessLookupError:
            pass
    wake = lab.event("sleep_end", actual_seconds=time.monotonic() - start)
    try:
        fresh = view.fresh("atlas", wake, 180)
        recovery = fresh["at"] - wake
    except TimeoutError:
        recovery = None
    ready = view.ready_probe()
    echo = view.echo("AFTERSLEEP", timeout=20)
    lab.record(
        {
            "case": "sleep",
            "control": case,
            "sleep_seconds": seconds,
            "recovery_seconds": recovery,
            "before": before,
            "usable_seconds": ready["ack_at"] - wake if ready["ack_at"] else None,
            "ready": ready,
            "pending_input_at": pending,
            "echo": echo,
        }
    )


def trial(args):
    source = json.loads(Path(args.template).read_text())["args"]
    settings = argparse.Namespace(
        **{
            **source,
            "output": args.output,
            "cpus": args.cpus,
            "trace": True,
            "capture": True,
            "trace_ssh": True,
        }
    )
    lab = Lab(settings)
    try:
        lab.setup()
        instrument_ssh(lab)
        lab.startup(120, 0)
        lab.fresh_viewer()
        freeze(lab, args.case, args.seconds)
    except BaseException:
        (lab.out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        # A failed/interrupted freeze must not leave application processes stopped.
        for pid in lab.pids("local") if "local" in lab.created else []:
            try:
                os.kill(pid, signal.SIGCONT)
            except (ProcessLookupError, PermissionError):
                pass
        lab.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output")
    parser.add_argument(
        "--template", default="dist/zstd-e2e-20261108/sleep/herdr-stock-1/manifest.json"
    )
    parser.add_argument("--case", choices=CASES)
    parser.add_argument("--cpus", default="32-35")
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
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
        started = (
            Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")", 1)[1].split()[19]
        )
        owner = f"{os.getpid()}:{started}"
    if args.case:
        trial(args)
        return 0
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / "plan.json").write_text(json.dumps(vars(args), indent=2) + "\n")
    (root / "freeze_audit.py").write_bytes(Path(__file__).read_bytes())
    children = set()

    def stop(_signal, _frame):
        for child in list(children):
            if child.poll() is None:
                child.send_signal(signal.SIGINT)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    def run_one(case, repeat, first):
        name = f"{case}-{repeat + 1}"
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            str(root / name),
            "--case",
            case,
            "--template",
            str(Path(args.template).resolve()),
            "--cpus",
            f"{first}-{first + 3}",
            "--seconds",
            str(args.seconds),
        ]
        with (root / f"{name}.log").open("w") as output:
            child = subprocess.Popen(
                command,
                env=dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=owner),
                stdout=output,
                stderr=subprocess.STDOUT,
            )
            children.add(child)
            code = child.wait()
            children.discard(child)
        print(name, "exit", code, flush=True)
        return {"name": name, "code": code, "command": command}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4 * args.repeats) as pool:
        jobs = [
            pool.submit(
                run_one, case, repeat, 32 + repeat * 16 + ((index + repeat) % 4) * 4
            )
            for repeat in range(args.repeats)
            for index, case in enumerate(CASES)
        ]
        results = [job.result() for job in jobs]
    (root / "execution.json").write_text(json.dumps(results, indent=2) + "\n")
    return int(any(r["code"] for r in results))


if __name__ == "__main__":
    sys.exit(main())
