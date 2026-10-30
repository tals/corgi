#!/usr/bin/env python3
"""Serial Corgi agent-count matrix, with a preserved plan and strict existing guards.

Run after builds/tests finish and a host-only placement pilot selects quiet cores:
  python3 tools/benchmarks/agent_scale.py run BINARY OUTPUT --node 0 --cpus 32-39 \
    --placement-receipt PLACEMENT.json
Use --preflight-only to check 64 agents before starting the measured matrix.
Rerun the same command with --resume to skip completed cases. A failed case is
never overwritten: choose a new output/placement and --counts/--workloads for
remaining cases. Combine those directories with `report OUTPUT SOURCE...`.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import corgi_costs


ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    "tools/benchmarks/agent_scale.py", "tools/benchmarks/cost_matrix.py",
    "tools/benchmarks/corgi_costs.py", "tools/benchmarks/cost_host.py",
    "tools/benchmarks/cost_clamp.py", "tools/benchmarks/cost_calibration.py",
    "tools/benchmarks/cost_blocks.py", "tools/benchmarks/cpu.ts",
    "tools/benchmarks/cpu_lock.ts", "tools/benchmarks/cpu_memory.ts",
    "tools/benchmarks/viewer_progress.ts", "tools/benchmarks/matrix_quality.ts",
    "tools/benchmarks/cost_matrix_geometry.ts", "tools/benchmarks/cost_matrix_herdr.ts",
    "tools/benchmarks/streaming_fixture.ts", "tools/benchmarks/streaming_provider.ts.fixture",
    "tools/benchmarks/observation_costs_fixture.ts", "tools/benchmarks/telemetry_snapshot.ts",
    "tools/ui_driver.ts", "tools/ghostty_themes.ts", "tests/provider_sim.ts",
    "scripts/process_scope.ts",
]


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def accepted(source):
    """Require both functional and original strict environmental acceptance."""
    attempts = [trial for trial in source.get("attempts", []) if trial.get("accepted")]
    if source.get("status") != "complete" or len(attempts) != 1:
        return None
    trial = attempts[0]
    return trial if trial.get("quality_pass") and trial.get("strict_environment_pass") else None


def verify_source(source, contract, case, warmup=30, seconds=60):
    count, workload = case.split("/")[-1].split("-")
    expected = dict(agents=int(count), workload=workload, scenario="default",
                    measurement_protocol="single-v4", noise_policy="strict", sibling_mean_limit=0.02,
                    seconds=seconds, warmup=warmup, initial_warmup=warmup, stream_mode="sparse",
                    producer_schedule="staggered", matched_geometry=True)
    if any(source.get(key) != value for key, value in expected.items()):
        raise ValueError(f"Trial settings differ from prospective plan: {case}")
    if source["binaries"]["corgi"]["sha256"] != contract["binary_sha256"]:
        raise ValueError(f"Binary differs from prospective plan: {case}")
    if source.get("uclamp", {}).get("requested_min") != 1024 or source.get("uclamp", {}).get("requested_max") != 1024:
        raise ValueError(f"Missing planned utilization clamps: {case}")


def report(output, directories):
    rows, excluded, plans, expected_cells = {}, [], [], set()
    for directory in directories:
        directory = directory.resolve()
        plan = read(directory / "plan.json")
        plans.append(dict(path=str(directory / "plan.json"), sha256=sha(directory / "plan.json"), plan=plan))
        for case in plan["contract"]["cases"]:
            count, workload = case.split("-")
            expected_cells.update((int(count), "idle" if workload == "idle" else "streaming", attached) for attached in [True, False])
            path = directory / case / "comparison.json"
            if not path.exists():
                excluded.append(dict(case=case, source=str(path), reason="not run"))
                continue
            source = read(path)
            trial = accepted(source)
            if trial is None:
                excluded.append(dict(case=case, source=str(path), reason=source.get("status"),
                                     attempts=source.get("attempts", [])))
                continue
            verify_source(source, plan["contract"], case)
            for row in trial["results"]:
                state = "streaming" if row["name"].startswith("streaming-") else "idle"
                attached = row["viewer_cpu"] is not None
                key = (source["agents"], state, attached)
                if key in rows:
                    raise ValueError(f"Duplicate accepted cell {key}; select one source explicitly")
                rows[key] = dict(agents=source["agents"], state=state, attached=attached,
                                 daemon_cpu=row["daemon_cpu"], viewer_cpu=row["viewer_cpu"],
                                 total_cpu=row["daemon_cpu"] + (row["viewer_cpu"] or 0),
                                 daemon_waited_child_cpu=row.get("daemon_child_cpu"),
                                 daemon_user_cpu=row.get("daemon_user_cpu"),
                                 daemon_system_cpu=row.get("daemon_system_cpu"),
                                 viewer_user_cpu=row.get("viewer_user_cpu"),
                                 viewer_system_cpu=row.get("viewer_system_cpu"),
                                 max_measured_sibling_busy=row.get("max_measured_sibling_busy"),
                                 max_trial_sibling_busy=trial["max_sibling_busy"],
                                 streaming_progress=row.get("streaming_progress"),
                                 streaming_quality=row.get("streaming_quality"),
                                 source=str(path), attempt=trial["name"],
                                 source_sha256=sha(path), node=trial["node"], cpus=trial["cpus"],
                                 seconds=row["seconds"], warmup=row["warmup"])
    identities = {plan["plan"]["contract"]["binary_sha256"] for plan in plans}
    if len(identities) != 1:
        raise ValueError("Cannot combine different binaries into one matrix")
    ordered = [rows[key] for key in sorted(rows, key=lambda key: (key[0], key[1] != "idle", not key[2]))]
    missing = sorted(expected_cells - rows.keys())
    output.mkdir(parents=True, exist_ok=True)
    save(output / "summary.json", dict(schema="corgi-agent-scale-v1", rows=ordered, excluded=excluded, plans=plans, missing_cells=missing,
                                       cpu_unit="percent of one logical core; process user+system including all threads",
                                       excluded_cpu="live providers, harness, and waited children",
                                       preflight_excluded=True))
    lines = ["# Rebased Corgi agent-count CPU matrix", "",
             "CPU is percent of one core, including every daemon/viewer thread. Detached viewers exited (—).",
             "Live providers and the harness are excluded. Each row is one accepted 60-second observation",
             "after 30 seconds warmup; this is workload characterization, not a confidence interval.", "",
             "| Agents | State | Viewer | Daemon CPU | Viewer CPU | Total CPU | Waited-child CPU (excluded) |",
             "| ---: | --- | --- | ---: | ---: | ---: | ---: |"]
    for row in ordered:
        viewer = f'{row["viewer_cpu"]:.2f}%' if row["attached"] else "—"
        child = f'{row["daemon_waited_child_cpu"]:.3f}%' if row["daemon_waited_child_cpu"] is not None else "—"
        lines.append(f'| {row["agents"]} | {row["state"]} | {"attached" if row["attached"] else "detached"} | '
                     f'{row["daemon_cpu"]:.2f}% | {viewer} | {row["total_cpu"]:.2f}% | {child} |')
    lines.extend(["", "N alternating Claude/Codex fixture providers plus one quiet shell; one visible first-agent pane.",
                  "Host geometry 160×48, provider PTYs 132×47. Streaming updates one sparse row at 20 Hz",
                  "per agent on a shared monotonic schedule with staggered phases. Idle agents stay at stable prompts",
                  "without terminal output or transcript changes. Default animation intensity 50 and resources remain enabled. Transcripts are minimal;",
                  "Codex app-server polling and real model inference are not exercised.", "",
                  "All included trials passed workload, executable/native identity, geometry, applicable cadence/animation,",
                  "affinity, utilization-clamp and cleanup checks, plus the original 2% whole-trial and measured-window",
                  "SMT-sibling mean guards. At most three noise retries per case; every attempt is preserved.", "",
                  "Waited-child CPU is separate: /proc cutime/cstime charges when a child is reaped and can include",
                  "work preceding the sample. It is not a contemporaneous subtree total.", "",
                  f'Accepted cells: {len(ordered)}. Missing cells: {len(missing)}. Preserved unrun or unaccepted source cases: {len(excluded)}. Correctness-only preflight CPU is excluded.', "",
                  f'Frozen executable SHA256: `{next(iter(identities))}`.', "",
                  "[Exact values, raw trial paths, guards and prospective plans](summary.json)", ""])
    (output / "summary.md").write_text("\n".join(lines))
    return ordered


def run(args):
    binary, output = args.binary.resolve(), args.output.resolve()
    build_path = Path(str(binary) + ".build.json")
    build = read(build_path)
    if build.get("testBuild") is not False or build.get("sha256") != sha(binary):
        raise ValueError("Use a frozen production binary with matching .build.json")
    counts = [int(value) for value in args.counts.split(",")]
    workloads = args.workloads.split(",")
    if not counts or len(counts) != len(set(counts)) or not set(counts) <= {4, 8, 32, 64}:
        raise ValueError("Counts must be a unique subset of 4,8,32,64")
    if not workloads or len(workloads) != len(set(workloads)) or not set(workloads) <= {"idle", "busy"}:
        raise ValueError("Workloads must be idle,busy or either alone")
    placement = corgi_costs.topology(args.cpus, args.node)
    receipt = read(args.placement_receipt)
    choice = receipt.get("selection")
    if not choice or choice["node"] != args.node or corgi_costs.cpu_list(choice["cpus"]) != set(placement["selected"]):
        raise ValueError("Placement must match a successful host-only pilot")
    contract = dict(binary=str(binary), binary_sha256=sha(binary), build=build,
                    head=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                    main_base=subprocess.check_output(["git", "merge-base", "HEAD", "origin/main"], cwd=ROOT, text=True).strip(),
                    sources={name: sha(ROOT / name) for name in SOURCES},
                    node=args.node, cpus=placement["cpus"], placement_sha256=sha(args.placement_receipt),
                    cases=[f"{count}-{workload}" for count in counts for workload in workloads],
                    preflight=["64-idle", "64-busy"], seconds=60, warmup=30,
                    stream_mode="sparse", producer_phase="staggered", noise_limit=0.02, noise_attempts=3)
    if output.exists():
        if not args.resume or read(output / "plan.json")["contract"] != contract:
            raise ValueError("Use a fresh output, or --resume with an unchanged plan/binary/harness")
    else:
        output.mkdir(parents=True)
        save(output / "plan.json", dict(schema="corgi-agent-scale-plan-v1", contract=contract,
                                        created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                        interpretation="Single-pass characterization, not a paired optimization comparison"))
        (output / "placement.json").write_bytes(args.placement_receipt.read_bytes())
        for name in SOURCES:
            destination = output / "source" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((ROOT / name).read_bytes())
    env = dict(os.environ)
    env.pop("CORGI_NATIVE_ROOT", None)
    env.pop("BUN_OPTIONS", None)
    jobs = [(f"preflight/{case}", 3, 3) for case in contract["preflight"]]
    if not args.preflight_only:
        jobs.extend((case, 30, 60) for case in contract["cases"])
    for case, warmup, seconds in jobs:
        path = output / case
        if path.exists():
            if (path / "comparison.json").exists():
                source = read(path / "comparison.json")
                if accepted(source):
                    verify_source(source, contract, case, warmup, seconds)
                    print(f"Already complete: {case}", flush=True)
                    continue
            raise ValueError(f"Preserved incomplete case: {path}; use a fresh directory for another prospective run")
        if sha(binary) != contract["binary_sha256"] or any(sha(ROOT / name) != digest for name, digest in contract["sources"].items()):
            raise ValueError("Binary or harness changed after the plan was saved")
        count, workload = case.split("/")[-1].split("-")
        path.parent.mkdir(parents=True, exist_ok=True)
        command = [sys.executable, str(ROOT / "tools/benchmarks/cost_matrix.py"), str(binary), str(binary), str(path),
                   "--single-corgi", "--agents", count, "--workload", workload, "--stream-mode", "sparse",
                   "--producer-phase", "staggered", "--initial-warmup", str(warmup), "--warmup", str(warmup),
                   "--seconds", str(seconds), "--node", str(args.node), "--cpus", placement["cpus"],
                   "--placement-receipt", str(output / "placement.json"), "--match-geometry", "--uclamp"]
        print(f"Starting {'correctness-only ' if case.startswith('preflight/') else ''}{case}", flush=True)
        with (output / (case.replace("/", "-") + ".log")).open("w") as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        report(output, [output])
        if result.returncode or not accepted(read(path / "comparison.json")):
            raise RuntimeError(f"Stopped at {case}; original rejection and all evidence retained in {path}")
        verify_source(read(path / "comparison.json"), contract, case, warmup, seconds)
        print(f"Complete: {case}", flush=True)
    report(output, [output])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    execute = commands.add_parser("run")
    execute.add_argument("binary", type=Path)
    execute.add_argument("output", type=Path)
    execute.add_argument("--node", type=int, choices=[0, 1], required=True)
    execute.add_argument("--cpus", required=True)
    execute.add_argument("--placement-receipt", type=Path, required=True)
    execute.add_argument("--counts", default="4,8,32,64")
    execute.add_argument("--workloads", default="idle,busy")
    execute.add_argument("--preflight-only", action="store_true")
    execute.add_argument("--resume", action="store_true")
    summary = commands.add_parser("report")
    summary.add_argument("output", type=Path)
    summary.add_argument("sources", type=Path, nargs="+")
    args = parser.parse_args()
    if args.command == "run":
        run(args)
    else:
        report(args.output, args.sources)


if __name__ == "__main__":
    main()
