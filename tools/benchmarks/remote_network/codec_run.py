#!/usr/bin/env python3
"""Run the existing network lab with optional external compression wrappers."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import traceback

from run import Lab, UID


def install_codec(lab, mode):
    bun = shutil.which("bun")
    bridge = Path(__file__).with_name("codec_bridge.ts").resolve()
    log = str(lab.out / "codec.jsonl")
    client = lab.root / "local/bin/ssh"
    config = str(lab.root / "local/home/.ssh/config")
    # Command-line settings precede the applications' Compression=yes options.
    compression = "no" if mode == "zstd" else "yes"
    prefix = ["/usr/bin/ssh", "-F", config, "-o", f"Compression={compression}"]
    if lab.args.trace_ssh:
        prefix += ["-vv", "-E", str(lab.out / "ssh-negotiation.log")]
    client.write_text(
        "#!/usr/bin/python3\nimport os,sys\n"
        + f"prefix={prefix!r}\nbridge={str(bridge)!r}\nbun={bun!r}\nlog={log!r}\nmode={mode!r}\n"
        + "args=sys.argv[1:]\nif mode=='zstd': args=[arg for arg in args if arg!='-C']\nselected=any('corgi-remote-bridge' in arg or 'remote-client-bridge' in arg for arg in args)\n"
        + "command=([bun,bridge,'client',mode,log]+prefix+args) if selected else (prefix+args)\nos.execv(command[0],command)\n"
    )
    client.chmod(0o700)
    for machine in ("atlas", "borealis"):
        path = lab.root / machine / "remote-shell"
        env = " ".join(shlex.quote(f"{k}={v}") for k, v in lab.envs[machine].items())
        wrapped = " ".join(
            shlex.quote(x)
            for x in [bun, str(bridge), "server", mode, log, "/bin/sh", "-c"]
        )
        path.write_text(
            "#!/bin/sh\n"
            + "printf '%s\\n' \"$SSH_ORIGINAL_COMMAND\" >> "
            + shlex.quote(str(lab.out / f"ssh-commands-{machine}.log"))
            + "\n"
            + 'case "$SSH_ORIGINAL_COMMAND" in\n'
            + f'  *corgi-remote-bridge*|*remote-client-bridge*) exec env -i {env} {wrapped} "$SSH_ORIGINAL_COMMAND" ;;\n'
            + f'  *) exec env -i {env} /bin/sh -c "$SSH_ORIGINAL_COMMAND" ;;\nesac\n'
        )
        path.chmod(0o700)
    lab.reset_ssh()
    manifest = json.loads((lab.out / "manifest.json").read_text())
    manifest["codec"] = {
        "mode": mode,
        "level": 3 if mode == "zstd" else None,
        "dictionary": False,
        "ssh_compression": compression,
        "bun": bun,
        "bridge_sha256": hashlib.sha256(bridge.read_bytes()).hexdigest(),
    }
    (lab.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    lab.event("codec_installed", **manifest["codec"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", choices=["corgi", "herdr"])
    parser.add_argument("binary")
    parser.add_argument("output")
    parser.add_argument(
        "--codec", choices=["stock", "identity", "zstd"], default="zstd"
    )
    parser.add_argument("--trace-ssh", action="store_true")
    parser.add_argument(
        "--suite",
        choices=["smoke", "startup", "stream", "faults", "sleep"],
        default="smoke",
    )
    parser.add_argument("--cpus", default="32-39")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument(
        "--stream-cases", default="sparse:1mbit,dense:1mbit,sparse:64kbit,dense:64kbit"
    )
    parser.add_argument("--stream-seconds", type=int, default=30)
    parser.add_argument("--stream-rtt", type=int, default=120)
    parser.add_argument(
        "--fault-cases", default="tcp_reset,blackhole3,blackhole35,downstream15"
    )
    parser.add_argument("--fault-kind", choices=["sparse", "dense"], default="sparse")
    parser.add_argument("--sleep-seconds", type=int, default=180)
    parser.add_argument("--rtts", default="20,120,300")
    args = parser.parse_args()
    args.panes = 4
    args.ansi = args.trace = args.capture = args.calibrate = False
    args.ssh_compression = "default"
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
    lab = Lab(args)
    try:
        lab.setup()
        if args.codec != "stock":
            install_codec(lab, args.codec)
        if args.suite == "startup":
            for rtt in map(int, args.rtts.split(",")):
                for repetition in range(args.repeats):
                    lab.startup_attempt(rtt, repetition)
                    lab.startup_attempt(rtt, repetition, warm=True)
        else:
            lab.startup(120, 0)
        if args.suite in ("smoke", "stream"):
            for repetition in range(args.repeats):
                for case in args.stream_cases.split(","):
                    if case == "loss":
                        lab.streaming(
                            "sparse",
                            None,
                            args.stream_seconds,
                            repetition,
                            loss=1,
                            jitter=10,
                        )
                    else:
                        kind, rate = case.split(":")
                        lab.streaming(
                            kind,
                            None if rate == "unlimited" else rate,
                            args.stream_seconds,
                            repetition,
                        )
        elif args.suite == "faults":
            for repetition in range(args.repeats):
                for case in args.fault_cases.split(","):
                    if case == "tcp_reset":
                        lab.reset_connection(repetition)
                    elif case.startswith("blackhole"):
                        lab.recover(
                            case,
                            lambda: lab.shape(loss=100),
                            int(case.removeprefix("blackhole")),
                            repetition,
                        )
                    elif case == "downstream15":
                        lab.recover(
                            case,
                            lambda: lab.shape(loss=100, direction="down"),
                            15,
                            repetition,
                        )
                    elif case == "isolated30":
                        lab.recover(
                            case,
                            lambda: lab.shape(loss=100),
                            30,
                            repetition,
                            isolation=True,
                        )
                    else:
                        raise ValueError(case)
        elif args.suite == "sleep":
            lab.fresh_viewer()
            lab.sleep(args.sleep_seconds)
    except BaseException:
        (lab.out / "failure.txt").write_text(traceback.format_exc())
        raise
    finally:
        lab.cleanup()


if __name__ == "__main__":
    main()
