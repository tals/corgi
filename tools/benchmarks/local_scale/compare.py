#!/usr/bin/env python3
"""Run a balanced before/after local transport comparison, serially."""
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
parser.add_argument("--before", type=Path, required=True)
parser.add_argument("--after", type=Path, required=True)
parser.add_argument("--placement", type=Path, required=True)
parser.add_argument("--seconds", type=int, default=15)
parser.add_argument("--bandwidth-seconds", type=int, default=5)
parser.add_argument("--warmup", type=int, default=5)
parser.add_argument("--pairs", type=int, default=2)
parser.add_argument("--counts", default="4,8,32")
parser.add_argument("--allow-noisy-placement", action="store_true", help="Prospectively choose the least busy candidate if none passes 2%; retain noise flags")
args = parser.parse_args()
args.output = args.output.resolve()
args.output.mkdir(parents=True, exist_ok=False)
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
placement = read(args.placement)
if not placement["selection"]:
    if not args.allow_noisy_placement:
        raise ValueError("Need a successful host-only placement pilot, or explicit noisy-host mode")
    best = min(placement["candidates"],key=lambda p:(p["worst_mean"],p["whole"]["aggregate"],p["node"],p["selected"]))
    placement["selection"] = dict(node=best["node"],cpus=best["cpus"],siblings=best["siblings"],
                                  l3_id=best["cores"][0]["l3_id"],worst_mean=best["worst_mean"],
                                  noisy_host=True,reason="No candidate passed 2%; least busy selected before paired measurements")
builds = {}
for name in ["before", "after"]:
    binary = getattr(args, name).resolve()
    metadata = read(Path(str(binary) + ".build.json"))
    if metadata["testBuild"] or metadata["sha256"] != sha(binary):
        raise ValueError("Need matching production binary metadata")
    builds[name] = dict(binary=str(binary), sha256=sha(binary), build=metadata)
for key in ["bunVersion", "nativeSHA256", "target"]:
    if builds["before"]["build"][key] != builds["after"]["build"][key]:
        raise ValueError("Build environment mismatch: " + key)
sources = [Path(__file__), Path(__file__).with_name("run.ts"), Path(__file__).with_name("producer.ts.fixture"),
           Path(__file__).with_name("socket_bytes.bt"), ROOT / "tools/ui_driver.ts",
           ROOT / "tools/benchmarks/streaming_fixture.ts", ROOT / "tools/benchmarks/viewer_progress.ts",
           ROOT / "tools/benchmarks/cpu_lock.ts", ROOT / "src/rpc.ts"]
counts = list(map(int, args.counts.split(",")))
order = []
for count in counts:
    for pair in range(args.pairs):
        for side in (["before", "after"] if pair % 2 == 0 else ["after", "before"]):
            order.append(dict(name=f"n{count}-p{pair}-{side}", agents=count, pair=pair, side=side))
plan = dict(schema="local-transport-comparison-v1", created_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            builds=builds, placement=placement, order=order,
            arguments={k: str(v) if isinstance(v, Path) else v for k,v in vars(args).items()},
            sources={str(p.relative_to(ROOT)):sha(p) for p in sources},
            noise_policy="Retain all planned successful trials, flag maximum SMT-sibling busy above 2%; preserve any failures and stop.",
            cpu_policy="Untraced windows only; separate traced bandwidth windows. 100% CPU = one logical core.")
(args.output / "plan.json").write_text(json.dumps(plan,indent=2)+"\n")
with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stat = Path(f"/proc/{os.getpid()}/stat").read_text().rsplit(")",1)[1].split()
    env = dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=f"{os.getpid()}:{stat[19]}")
    for trial in order:
        if any(sha(Path(b["binary"])) != b["sha256"] for b in builds.values()):
            raise RuntimeError("Measured executable changed")
        if any(sha(ROOT/p) != digest for p,digest in plan["sources"].items()):
            raise RuntimeError("Measured harness changed")
        name = trial["name"]
        command = ["taskset", "-c", "0", "bun", str(Path(__file__).with_name("run.ts")),
                   "--binary", builds[trial["side"]]["binary"], "--out", str(args.output / name),
                   "--agents", str(trial["agents"]), "--repeat", str(trial["pair"]),
                   "--seconds", str(args.seconds), "--warmup", str(args.warmup),
                   "--bandwidth-seconds", str(args.bandwidth_seconds), "--trace", "off",
                   "--cpus", placement["selection"]["cpus"]]
        print(json.dumps(dict(starting=name,command=command)),flush=True)
        with (args.output / (name+".log")).open("w") as log:
            result = subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f"Failed {name}; all evidence preserved")
        print(json.dumps(dict(completed=name)),flush=True)
