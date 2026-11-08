#!/usr/bin/env python3
"""Serial, order-rotated local daemon CPU/socket-traffic measurements."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("--binary", type=Path, default=ROOT / "dist/corgi")
parser.add_argument("--placement", type=Path, required=True)
parser.add_argument("--seconds", type=int, default=20)
parser.add_argument("--warmup", type=int, default=5)
parser.add_argument("--repeats", type=int, default=3)
parser.add_argument("--counts", default="4,8,32")
parser.add_argument("--scenarios", default="idle,mixed,spammy")
parser.add_argument("--attachments", default="attached,detached")
parser.add_argument("--trace", choices=["on", "off"], default="on")
args = parser.parse_args()
args.binary = args.binary.resolve()
args.output = args.output.resolve()
args.output.mkdir(parents=True, exist_ok=False)
placement = json.loads(args.placement.read_text())
selection = placement["selection"]
if not selection:
    raise ValueError("Need a successful host-only placement pilot")
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
sources = list(Path(__file__).parent.glob("*.ts")) + list(Path(__file__).parent.glob("*.fixture")) + list(Path(__file__).parent.glob("*.py")) + list(Path(__file__).parent.glob("*.bt"))
plan = dict(created_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            binary=str(args.binary), binary_sha256=sha(args.binary),
            build=json.loads(Path(str(args.binary) + ".build.json").read_text()),
            head=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            sources={str(p.relative_to(ROOT)): sha(p) for p in sources},
            arguments={k: str(v) if isinstance(v, Path) else v for k,v in vars(args).items()},
            placement=placement, cpu_unit="percent of one logical core, user+system, all process threads",
            noise_policy="Keep all planned trials; flag windows whose maximum SMT-sibling busy fraction exceeds 2%.")
(args.output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stat = Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")",1)[1].split()
    env = dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{stat[19]}")
    counts = args.counts.split(",")
    for repeat in range(args.repeats):
        order = counts[repeat % len(counts):] + counts[:repeat % len(counts)]
        for count in order:
            if sha(args.binary) != plan["binary_sha256"] or any(sha(ROOT / p) != digest for p,digest in plan["sources"].items()):
                raise RuntimeError("Benchmark inputs changed after plan creation")
            name = f"r{repeat}-{count}"
            command = ["taskset", "-c", "0", "bun", str(Path(__file__).with_name("run.ts")),
                       "--binary", str(args.binary), "--out", str(args.output / name), "--agents", count,
                       "--repeat", str(repeat), "--seconds", str(args.seconds), "--warmup", str(args.warmup),
                       "--cpus", selection["cpus"], "--scenarios", args.scenarios, "--attachments", args.attachments, "--trace", args.trace]
            print(json.dumps(dict(starting=name, command=command)), flush=True)
            with (args.output / (name + ".log")).open("w") as log:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            if result.returncode:
                raise RuntimeError(f"Failed {name}; all evidence preserved")
            print(json.dumps(dict(completed=name)), flush=True)
