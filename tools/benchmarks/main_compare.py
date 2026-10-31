#!/usr/bin/env python3
"""Serial, prospectively ordered main/candidate CPU pairs.

  python3 tools/benchmarks/main_compare.py run MAIN CANDIDATE OUTPUT \
    --node 0 --cpus 48-55 --placement-receipt PILOT.json

Build and pilot first. Never overlap application trials with other work.
Resume only an unchanged plan. Failed legs are preserved; replace the whole
pair in a fresh run, then merge complete pairs with `report OUTPUT SOURCE...`.
"""

import argparse
import datetime
import math
import os
from pathlib import Path
import subprocess
import sys
import time

import agent_scale
import corgi_costs


ROOT = agent_scale.ROOT
SOURCES = [*agent_scale.SOURCES, "tools/benchmarks/main_compare.py"]
COUNTS = [4, 8, 32, 64]
WORKLOADS = ["idle", "busy"]
ROLES = ["main", "candidate"]
SETTINGS = dict(seconds=60, warmup=30, stream_mode="sparse", producer_phase="staggered",
                noise_limit=0.02, noise_attempts=3, preflight_seconds=3, preflight_warmup=3)
DIAGNOSTICS = dict(inter_leg_gap_seconds=60, window_start_separation_seconds=300,
                   frequency_relative_difference=0.05)
read, save, sha = agent_scale.read, agent_scale.save, agent_scale.sha


def timing(settings):
    return {key: settings[key] for key in ("warmup", "seconds")}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def epoch(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def order(case):
    count, workload = case.split("-")
    return ROLES[:] if (COUNTS.index(int(count)) + WORKLOADS.index(workload)) % 2 == 0 else ROLES[::-1]


def selection(counts, workloads):
    counts, workloads = [int(x) for x in counts.split(",")], workloads.split(",")
    if not counts or len(set(counts)) != len(counts) or not set(counts) <= set(COUNTS):
        raise ValueError("Counts must be a unique subset of 4,8,32,64")
    if not workloads or len(set(workloads)) != len(workloads) or not set(workloads) <= set(WORKLOADS):
        raise ValueError("Workloads must be a unique subset of idle,busy")
    return [f"{n}-{w}" for n in COUNTS if n in counts for w in WORKLOADS if w in workloads]


def frozen_binary(path):
    path = path.resolve()
    metadata = Path(str(path) + ".build.json")
    build = read(metadata)
    digest = sha(path)
    if build.get("testBuild") is not False or build.get("sha256") != digest:
        raise ValueError("Use frozen production binaries with matching .build.json files")
    return dict(path=str(path), sha256=digest, build=build, build_sha256=sha(metadata))


def compatibility(contract):
    return dict(binaries={role: {k: contract["binaries"][role][k] for k in ("sha256", "build_sha256")}
                          for role in ROLES}, main_base=contract["main_base"], sources=contract["sources"],
                settings=contract["settings"], diagnostics=contract["diagnostics"])


def execution_path(directory, case, role):
    return directory / (case.replace("/", "-") + f"-{role}-execution.json")


def verify_leg(source, contract, case, role, warmup=30, seconds=60):
    binary = contract["binaries"][role]
    agent_scale.verify_source(source, dict(binary_sha256=binary["sha256"]), case, warmup, seconds)
    trial = agent_scale.accepted(source)
    if trial is None:
        raise ValueError(f"Unaccepted leg: {case}/{role}")
    if source.get("diagnostic_frequency_requested") or source.get("native_override") is not None:
        raise ValueError(f"Unexpected diagnostic treatment: {case}/{role}")
    if source["binaries"]["corgi"]["build"] != binary["build"]:
        raise ValueError(f"Build metadata differs: {case}/{role}")
    if set(trial.get("executable_sha256", {}).values()) != {binary["sha256"]} or trial.get("native_receipt", {}).get("expected") != binary["build"].get("nativeSHA256"):
        raise ValueError(f"Loaded binary/native identity differs: {case}/{role}")
    for name, digest in source["harnesses"].items():
        if contract["sources"].get("tools/benchmarks/" + name) != digest:
            raise ValueError(f"Harness differs: {case}/{role}/{name}")
    cpus = corgi_costs.cpu_list(contract["cpus"])
    if trial["node"] != contract["node"] or corgi_costs.cpu_list(trial["cpus"]) != cpus:
        raise ValueError(f"Placement differs: {case}/{role}")
    if f'--membind={contract["node"]}' not in trial["command"]:
        raise ValueError(f"Memory binding differs: {case}/{role}")
    flags = ["complete", "producers_verified", "settings_verified", "idle_verified", "embedded_native_verified",
             "executable_verified", "affinity_verified", "clamps_verified", "measured_sibling_guard_passed", "clean"]
    if not all(trial.get(key) is True for key in flags) or trial["max_sibling_busy"] >= 0.02:
        raise ValueError(f"Missing strict acceptance guard: {case}/{role}")
    prefix = "idle" if case.endswith("-idle") else "streaming"
    expected = {f"{prefix}-agents-viewer", f"{prefix}-agents-detached"}
    if len(trial["results"]) != 2 or {row["name"] for row in trial["results"]} != expected:
        raise ValueError(f"Incomplete phases: {case}/{role}")
    for row in trial["results"]:
        attached = row["name"].endswith("-viewer")
        if (row["viewer_cpu"] is not None) != attached or row["warmup"] != warmup or row["seconds"] < seconds - 0.01:
            raise ValueError(f"Phase differs: {case}/{role}")
        if not row.get("affinity_verified") or not row.get("clamps_verified") or not 0 <= row["max_measured_sibling_busy"] < 0.02:
            raise ValueError(f"Phase guard failed: {case}/{role}")
        for component in ["daemon", "daemon_child", *(["viewer"] if attached else [])]:
            values = [row[f"{component}_{suffix}"] for suffix in ("cpu", "user_cpu", "system_cpu")]
            if not all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0 for x in values):
                raise ValueError(f"Invalid CPU accounting: {case}/{role}")
            if not math.isclose(values[0], sum(values[1:]), abs_tol=1e-9):
                raise ValueError(f"CPU accounting does not reconcile: {case}/{role}")
    return trial


def load_leg(directory, contract, case, role, warmup=30, seconds=60):
    path = directory / case / role / "comparison.json"
    receipt = execution_path(directory, case, role)
    if not path.exists() or not receipt.exists():
        return None
    source, execution = read(path), read(receipt)
    if agent_scale.accepted(source) is None or execution.get("returncode") != 0 or not execution.get("finished_at"):
        return None
    trial = verify_leg(source, contract, case, role, warmup, seconds)
    if execution.get("source_sha256") != sha(path):
        raise ValueError(f"Leg receipt changed: {case}/{role}")
    if epoch(execution["finished_at"]) < epoch(execution["started_at"]):
        raise ValueError(f"Invalid leg timestamps: {case}/{role}")
    return dict(source=source, trial=trial, execution=execution, path=path)


def metric(row):
    return dict(daemon_cpu=row["daemon_cpu"], viewer_cpu=row["viewer_cpu"],
                total_cpu=row["daemon_cpu"] + (row["viewer_cpu"] or 0),
                daemon_waited_child_cpu=row["daemon_child_cpu"],
                daemon_user_cpu=row["daemon_user_cpu"], daemon_system_cpu=row["daemon_system_cpu"],
                viewer_user_cpu=row["viewer_user_cpu"], viewer_system_cpu=row["viewer_system_cpu"],
                started_at=row["started_at"],
                finished_at=datetime.datetime.fromtimestamp(epoch(row["started_at"]) + row["seconds"], datetime.timezone.utc).isoformat(),
                seconds=row["seconds"], selected_busy_weighted_observed_khz=row.get("selected_busy_weighted_observed_khz"))


def report(output, directories):
    pairs, rows, excluded, plans, expected = {}, [], [], [], set()
    identity = timings = None
    for directory in directories:
        directory = directory.resolve()
        plan_path = directory / "plan.json"
        plan = read(plan_path)
        if plan.get("schema") != "corgi-main-compare-plan-v1":
            raise ValueError("Expected a main/candidate paired plan")
        contract = plan["contract"]
        settings = contract["settings"]
        if {**settings, **timing(SETTINGS)} != SETTINGS or contract["diagnostics"] != DIAGNOSTICS:
            raise ValueError("Measurement settings differ from the paired protocol")
        if timings is not None and timing(settings) != timings:
            raise ValueError("Cannot merge runs with different warmups or sample lengths")
        timings = timing(settings)
        if contract["preflight"] != ["64-idle", "64-busy"]:
            raise ValueError("Required correctness preflights differ")
        current = compatibility(contract)
        if identity is not None and identity != current:
            raise ValueError("Cannot merge changed binaries, build metadata, harnesses or settings")
        identity = current
        if any(sha(directory / "source" / name) != digest for name, digest in contract["sources"].items()):
            raise ValueError("Frozen harness copy differs from plan")
        if sha(directory / "placement.json") != contract["placement_sha256"]:
            raise ValueError("Frozen placement receipt differs from plan")
        for role in ROLES:
            if sha(directory / f"{role}.build.json") != contract["binaries"][role]["build_sha256"]:
                raise ValueError("Frozen build metadata differs from plan")
        plans.append(dict(path=str(plan_path), sha256=sha(plan_path), plan=plan))
        preflight_verified = False
        for case in contract["cases"]:
            expected.add(case)
            if contract["orders"][case] != order(case):
                raise ValueError(f"Pair order differs from prospective full-matrix indices: {case}")
            legs = {role: load_leg(directory, contract, case, role, settings["warmup"], settings["seconds"]) for role in ROLES}
            if any(leg is None for leg in legs.values()):
                excluded.append(dict(case=case, run=str(directory), reason="Incomplete or unaccepted pair",
                                     accepted_roles=[role for role, leg in legs.items() if leg is not None]))
                continue
            if not preflight_verified:
                if any(load_leg(directory, contract, f"preflight/{preflight}", role, 3, 3) is None
                       for preflight in contract["preflight"] for role in ROLES):
                    raise ValueError("Complete pair lacks accepted correctness preflights")
                preflight_verified = True
            if case in pairs:
                raise ValueError(f"Duplicate complete pair: {case}; choose one run explicitly")
            first, second = [legs[role] for role in order(case)]
            gap = epoch(second["execution"]["started_at"]) - epoch(first["execution"]["finished_at"])
            if gap < 0:
                raise ValueError(f"Pair legs overlap or violate planned order: {case}")
            evidence = {role: dict(source=str(leg["path"]), source_sha256=sha(leg["path"]),
                                   attempt=leg["trial"]["name"], source_started_at=leg["source"]["started_at"],
                                   execution=leg["execution"], max_trial_sibling_busy=leg["trial"]["max_sibling_busy"])
                        for role, leg in legs.items()}
            pairs[case] = dict(case=case, run=str(directory), order=order(case), node=contract["node"],
                               cpus=contract["cpus"], memory_node=contract["node"], inter_leg_gap_seconds=gap, legs=evidence)
            for attached in [True, False]:
                selected = {role: next(r for r in leg["trial"]["results"] if (r["viewer_cpu"] is not None) == attached)
                            for role, leg in legs.items()}
                values = {role: metric(row) for role, row in selected.items()}
                delta, reduction = {}, {}
                for key in ("daemon_cpu", "viewer_cpu", "total_cpu"):
                    main, candidate = values["main"][key], values["candidate"][key]
                    delta[key] = candidate - main if main is not None else None
                    reduction[key] = 100 * (main - candidate) / main if main else None
                separation = abs(epoch(values["candidate"]["started_at"]) - epoch(values["main"]["started_at"]))
                frequencies = [values[role]["selected_busy_weighted_observed_khz"] for role in ROLES]
                frequency_difference = abs(frequencies[0] - frequencies[1]) / min(frequencies) if all(frequencies) else None
                flags = []
                if gap > DIAGNOSTICS["inter_leg_gap_seconds"]:
                    flags.append("inter-leg gap exceeds 60 seconds")
                if separation > DIAGNOSTICS["window_start_separation_seconds"]:
                    flags.append("matched-window starts differ by more than 300 seconds")
                if frequency_difference is None:
                    flags.append("observed frequency unavailable")
                elif frequency_difference > DIAGNOSTICS["frequency_relative_difference"]:
                    flags.append("observed frequency differs by more than 5%; diagnostic only")
                count, workload = case.split("-")
                rows.append(dict(agents=int(count), state="idle" if workload == "idle" else "streaming", attached=attached,
                                 pair=case, **values, candidate_minus_main_percentage_points=delta,
                                 candidate_reduction_percent=reduction, node=contract["node"], cpus=contract["cpus"],
                                 window_start_separation_seconds=separation,
                                 observed_frequency_relative_difference=frequency_difference, diagnostic_flags=flags))
    rows.sort(key=lambda r: (r["agents"], r["state"] != "idle", not r["attached"]))
    output.mkdir(parents=True, exist_ok=True)
    save(output / "summary.json", dict(schema="corgi-main-compare-v1", rows=rows, pairs=list(pairs.values()),
                                       missing_pairs=sorted(expected - pairs.keys()), excluded=excluded, plans=plans,
                                       interpretation="Single-pair observations, not confidence intervals or a causal effect estimate",
                                       cpu_unit="Percent of one logical CPU; process user+system including all threads",
                                       excluded_cpu="Live providers, harness and separately reported waited-child CPU",
                                       frequency="Diagnostic only; reported kHz is not effective execution cycles; no frequency normalization or rejection",
                                       preflight_excluded=True))
    lines = ["# Unmodified main versus rebased candidate", "",
             f"Each row is one matched pair of {timings['seconds']}-second observations after {timings['warmup']}-second warmups, not a confidence interval or causal effect estimate.",
             "CPU is percent of one logical CPU, including all daemon/viewer threads. Providers and harness are excluded; detached viewers exited (—).", "",
             "| Agents | State | Viewer | Main daemon | Candidate daemon | Main viewer | Candidate viewer | Main total | Candidate total | Total change (pp) | Total reduction | Main child* | Candidate child* |",
             "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    fmt = lambda value: "—" if value is None else f"{value:.3f}%"
    for row in rows:
        m, c = row["main"], row["candidate"]
        cells = [str(row["agents"]), row["state"], "attached" if row["attached"] else "detached",
                 *[fmt(v[component]) for component in ("daemon_cpu", "viewer_cpu", "total_cpu") for v in (m, c)],
                 f'{row["candidate_minus_main_percentage_points"]["total_cpu"]:+.3f}',
                 fmt(row["candidate_reduction_percent"]["total_cpu"]), fmt(m["daemon_waited_child_cpu"]), fmt(c["daemon_waited_child_cpu"])]
        lines.append("| " + " | ".join(cells) + " |")
    lines.extend(["", "*Waited-child CPU is separate from totals. Linux charges it on wait, potentially including work before the sample; it is not a contemporaneous subtree total.", "",
                  "Sparse 20 Hz staggered producers, one visible first-agent pane, 160×48 host / 132×47 PTYs, default animation/resources, minimal transcripts and isolated non-Git projects.",
                  "Real inference, full Codex app-server polling and repository/worktree/push scanning are excluded.",
                  "Both legs share NUMA/core/memory placement and strict 2% whole-trial/measured-window sibling guards. Preflight and rejected timings are excluded.",
                  "Leader affinity and recursive utilization clamps are checked; child-thread affinity is inherited but not exhaustively recorded.",
                  "Observed frequency is diagnostic, not effective execution cycles; time/frequency flags never change acceptance or normalize CPU.", ""])
    for case, pair in pairs.items():
        lines.append(f'- {case}: {" → ".join(pair["order"])}, NUMA {pair["node"]}, CPUs `{pair["cpus"]}`, gap {pair["inter_leg_gap_seconds"]:.3f}s; '
                     + ", ".join(f'[{role} receipt]({pair["legs"][role]["source"]})' for role in ROLES) + ".")
    for row in rows:
        if row["diagnostic_flags"]:
            lines.append(f'- Diagnostic, {row["pair"]} {"attached" if row["attached"] else "detached"}: ' + "; ".join(row["diagnostic_flags"]) + ".")
    lines.extend(["", f"Complete pairs: {len(pairs)}. Missing pairs: {len(expected - pairs.keys())}. Excluded incomplete source pairs: {len(excluded)}.",
                  "[Exact component differences, timestamps, frequency diagnostics, source hashes and plans](summary.json)", ""])
    (output / "summary.md").write_text("\n".join(lines))
    return rows


def run(args):
    binaries = {role: frozen_binary(getattr(args, role)) for role in ROLES}
    main_base = subprocess.check_output(["git", "merge-base", "HEAD", "origin/main"], cwd=ROOT, text=True).strip()
    if binaries["main"]["build"].get("releaseCommit") != main_base:
        raise ValueError("Main binary must be built from the recorded main base commit")
    if binaries["main"]["sha256"] == binaries["candidate"]["sha256"]:
        raise ValueError("Main and candidate must be distinct frozen binaries")
    placement = corgi_costs.topology(args.cpus, args.node)
    pilot = read(args.placement_receipt)
    choice = pilot.get("selection")
    if pilot.get("status") != "selected" or not choice or choice["node"] != args.node or corgi_costs.cpu_list(choice["cpus"]) != set(placement["selected"]):
        raise ValueError("Placement must match a successful host-only pilot")
    cases = selection(args.counts, args.workloads)
    contract = dict(binaries=binaries, main_base=main_base,
                    head=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                    sources={name: sha(ROOT / name) for name in SOURCES},
                    settings={**SETTINGS, "warmup": args.warmup, "seconds": args.seconds}, diagnostics=DIAGNOSTICS,
                    node=args.node, cpus=placement["cpus"], placement_sha256=sha(args.placement_receipt),
                    cases=cases, orders={case: order(case) for case in cases}, preflight=["64-idle", "64-busy"])
    output = args.output.resolve()
    if output.exists():
        if not args.resume or read(output / "plan.json")["contract"] != contract:
            raise ValueError("Use a fresh output, or --resume with an unchanged plan/binaries/harness")
    else:
        output.mkdir(parents=True)
        save(output / "plan.json", dict(schema="corgi-main-compare-plan-v1", contract=contract, created_at=now()))
        (output / "placement.json").write_bytes(args.placement_receipt.read_bytes())
        for role in ROLES:
            (output / f"{role}.build.json").write_bytes(Path(binaries[role]["path"] + ".build.json").read_bytes())
        for name in SOURCES:
            destination = output / "source" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((ROOT / name).read_bytes())
    jobs = [(f"preflight/{case}", role, 3, 3) for case in contract["preflight"] for role in order(case)]
    if not args.preflight_only:
        jobs.extend((case, role, args.warmup, args.seconds) for case in cases for role in order(case))
    env = dict(os.environ)
    for key in ("CORGI_NATIVE_ROOT", "BUN_OPTIONS"):
        env.pop(key, None)
    for case, role, warmup, seconds in jobs:
        path = output / case / role
        if path.exists() or execution_path(output, case, role).exists():
            if load_leg(output, contract, case, role, warmup, seconds):
                print(f"Already complete: {case}/{role}", flush=True)
                continue
            raise ValueError(f"Preserved incomplete leg: {path}; replace the whole pair in a fresh run")
        if any(frozen_binary(Path(value["path"])) != value for value in binaries.values()) or any(sha(ROOT / name) != digest for name, digest in contract["sources"].items()):
            raise ValueError("Binary, build metadata or harness changed after the plan was saved")
        count, workload = case.split("/")[-1].split("-")
        binary = binaries[role]["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        command = [sys.executable, str(ROOT / "tools/benchmarks/cost_matrix.py"), binary, binary, str(path),
                   "--single-corgi", "--agents", count, "--workload", workload, "--stream-mode", "sparse",
                   "--producer-phase", "staggered", "--initial-warmup", str(warmup), "--warmup", str(warmup),
                   "--seconds", str(seconds), "--node", str(args.node), "--cpus", placement["cpus"],
                   "--placement-receipt", str(output / "placement.json"), "--match-geometry", "--uclamp"]
        execution = dict(started_at=now(), command=command, role=role, case=case)
        receipt = execution_path(output, case, role)
        save(receipt, execution)
        started = time.monotonic()
        print(f"Starting {'correctness-only ' if case.startswith('preflight/') else ''}{case}/{role}", flush=True)
        with (output / (case.replace("/", "-") + f"-{role}.log")).open("w") as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        execution.update(finished_at=now(), elapsed_seconds=time.monotonic() - started, returncode=result.returncode,
                         source_sha256=sha(path / "comparison.json") if (path / "comparison.json").exists() else None)
        save(receipt, execution)
        report(output, [output])
        if result.returncode or load_leg(output, contract, case, role, warmup, seconds) is None:
            raise RuntimeError(f"Stopped at {case}/{role}; every attempt remains in {path}")
        print(f"Complete: {case}/{role}", flush=True)
    report(output, [output])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    execute = commands.add_parser("run")
    execute.add_argument("main", type=Path)
    execute.add_argument("candidate", type=Path)
    execute.add_argument("output", type=Path)
    execute.add_argument("--node", type=int, choices=[0, 1], required=True)
    execute.add_argument("--cpus", required=True)
    execute.add_argument("--placement-receipt", type=Path, required=True)
    execute.add_argument("--counts", default="4,8,32,64")
    execute.add_argument("--workloads", default="idle,busy")
    execute.add_argument("--warmup", type=int, default=SETTINGS["warmup"], help="Seconds; shorter runs are noisier")
    execute.add_argument("--seconds", type=int, default=SETTINGS["seconds"], help="Sample seconds per phase")
    execute.add_argument("--preflight-only", action="store_true")
    execute.add_argument("--resume", action="store_true")
    summary = commands.add_parser("report")
    summary.add_argument("output", type=Path)
    summary.add_argument("sources", type=Path, nargs="+")
    args = parser.parse_args()
    run(args) if args.command == "run" else report(args.output, args.sources)


if __name__ == "__main__":
    main()
