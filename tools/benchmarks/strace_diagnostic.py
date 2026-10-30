#!/usr/bin/env python3
"""Prepare/run a separate launch-traced sparse fixture; syscall counts are not CPU costs."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def replace_once(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise ValueError(f"Expected one launch boundary in {path}")
    path.write_text(text.replace(old, new))


def prepare(parent, output, binary, herdr, seconds, warmup, node):
    parent, output, binary, herdr = (p.resolve() for p in [parent, output, binary, herdr])
    if output.exists():
        raise ValueError("Use a fresh diagnostic directory")
    output.mkdir(parents=True)
    overlay, traces = output / "observer", output / "traces"
    shutil.copytree(parent, overlay, symlinks=True, ignore=shutil.ignore_patterns("__pycache__"))
    traces.mkdir(mode=0o700)
    strace = Path(shutil.which("strace") or "/usr/bin/strace")
    wrapper = output / "trace-app"
    wrapper.write_text("#!/bin/sh\nset -eu\nrole=$1\nshift\ncase \"$role\" in daemon|viewer) ;; *) exit 64 ;; esac\n" +
                       "exec " + shlex.quote(str(strace)) + " -D -ff -ttt -T -s 64 -o " +
                       shlex.quote(str(traces)) + '/"$role" -- "$@"\n')
    wrapper.chmod(0o700)
    cpu = overlay / "tools/benchmarks/cpu.ts"
    # Locate the exact seed statement without changing binary identity anywhere else.
    lines = cpu.read_text().splitlines()
    launches = [line for line in lines if "await s.seed(" in line and "start`" in line]
    if len(launches) != 1:
        raise ValueError("Expected one daemon seed launch")
    quoted = shlex.quote(str(wrapper))
    replace_once(cpu, launches[0], launches[0].replace("s.seed(`", "s.seed(" + json.dumps(quoted + " daemon ") + " + `", 1))
    ui = overlay / "tools/ui_driver.ts"
    replace_once(ui, 'Bun.spawn([this.exe, "--no-update"],',
                 'Bun.spawn([' + json.dumps(str(wrapper)) + ', "viewer", this.exe, "--no-update"],')
    matrix = overlay / "tools/benchmarks/cost_matrix.py"
    replace_once(matrix, '        "paired_product_comparison": not args.single_corgi,',
                 '        "paired_product_comparison": False,\n'
                 '        "diagnostic": "ancestor-launched-strace; CPU numbers are perturbed and not performance evidence",')
    build_path = Path(str(binary) + ".build.json")
    build = json.loads(build_path.read_text())
    if sha(binary) != build["sha256"]:
        raise ValueError("Binary build receipt mismatch")
    command = ["python3", "-B", str(matrix), str(binary), str(herdr), str(output / "run"),
               "--single-corgi", "--scenario", "sparse", "--node", str(node), "--agents", "16",
               "--match-geometry", "--uclamp", "--seconds", str(seconds),
               "--initial-warmup", "20", "--warmup", str(warmup)]
    modified = [cpu, ui, matrix]
    receipt = {"kind": "syscall-diagnostic", "created_at": datetime.now(timezone.utc).isoformat(),
               "harness_sha256": sha(Path(__file__)),
               "parent_observer": str(parent), "parent_manifest_sha256": sha(parent / "frozen-manifest.json"),
               "binary": str(binary), "binary_sha256": sha(binary), "build": build,
               "strace": str(strace), "strace_sha256": sha(strace),
               "ptrace_scope": Path("/proc/sys/kernel/yama/ptrace_scope").read_text().strip(),
               "wrapper_sha256": sha(wrapper), "command": command,
               "overlay": {str(p.relative_to(overlay)): sha(p) for p in modified},
               "limits": ["No attach to existing processes, ptrace policy override, host setting or capability change.",
                          "The original app binary remains Session.exe/daemon and the recorded binary identity.",
                          "strace -D preserves the launched tracee as the caller child; observed PIDs/executable hashes must confirm this.",
                          "Forked provider descendants are traced, but only proven daemon/viewer TIDs enter the syscall report.",
                          "Traced CPU and syscall -T wall/blocked durations are not CPU-cost rankings.",
                          "Existing geometry, progress, animation, clamp, sibling, binary/native and cleanup guards are unchanged."]}
    save(output / "trace-receipt.json", receipt)
    return receipt


def calls(path):
    """Yield one entry per syscall, joining resumed lines and retaining entry time."""
    with path.open(errors="replace") as stream:
        yield from parse_lines(stream)


def parse_lines(lines):
    pending = None
    for line in lines:
        line = line.rstrip("\n")
        match = re.match(r"^(\d+\.\d+)\s+(.*)$", line)
        if not match:
            continue
        at, body = float(match[1]), match[2]
        resumed = re.match(r"^<\.\.\. (\w+) resumed>(.*)$", body)
        if resumed:
            if not pending or pending["name"] != resumed[1]:
                yield {"at": at, "unmatched_resume": resumed[1]}
                continue
            call = pending
            pending = None
            call["body"] += resumed[2]
        else:
            entry = re.match(r"^(\w+)\(", body)
            if not entry:
                continue
            call = {"at": at, "name": entry[1], "body": body}
            if "<unfinished ...>" in body:
                if pending:
                    yield {**pending, "incomplete": True}
                call["body"] = body.replace("<unfinished ...>", "")
                pending = call
                continue
        result = re.match(r"(-?\d+|\?)(?:\s+([A-Z][A-Z0-9_]+))?", call["body"].rpartition(" = ")[2])
        duration = re.search(r"<([0-9.]+)>$", call["body"])
        call.update(result=result[1] if result else None, errno=result[2] if result else None,
                    wall_seconds=float(duration[1]) if duration else None)
        yield call
    if pending:
        yield {**pending, "incomplete": True}


def summarize(output):
    output = output.resolve()
    comparison = json.loads((output / "run/comparison.json").read_text())
    reports = []
    for attempt in comparison["attempts"]:
        run = output / "run" / attempt["name"]
        host, results = (json.loads((run / name).read_text()) for name in ["host.json", "results.json"])
        for row in results["results"]:
            start = datetime.fromisoformat(row["started_at"].replace("Z", "+00:00")).timestamp()
            end = start + row["seconds"]
            roles = {}
            for role in ["daemon", "viewer"]:
                pid = results.get(role)
                if not pid:
                    continue
                names = defaultdict(set)
                for sample in host["samples"]:
                    for tid, value in sample[role + "_threads"].items():
                        names[tid].add(value["name"])
                observed = set(names)
                files = {p.suffix[1:]: p for p in (output / "traces").glob(role + ".*") if p.suffix[1:].isdigit()}
                proven = set(observed)
                missing = sorted(proven - files.keys())
                threads = []
                # A CLONE_THREAD child belongs to this same thread group even if a
                # short lifetime fell between the observer's half-second samples.
                todo = list(proven & files.keys())
                while todo:
                    tid = todo.pop()
                    counts, errors = Counter(), defaultdict(Counter)
                    incomplete, unmatched, wall = 0, 0, 0.0
                    for call in calls(files[tid]):
                        if call.get("name") in ["clone", "clone3"] and "CLONE_THREAD" in call["body"]:
                            child = call.get("result")
                            if child and child.isdigit() and int(child) > 0 and child not in proven:
                                proven.add(child)
                                if child in files:
                                    todo.append(child)
                                else:
                                    missing.append(child)
                        if not start <= call["at"] < end:
                            continue
                        if "unmatched_resume" in call:
                            unmatched += 1
                            continue
                        counts[call["name"]] += 1
                        if call.get("errno"):
                            errors[call["name"]][call["errno"]] += 1
                        incomplete += bool(call.get("incomplete"))
                        wall += call.get("wall_seconds") or 0
                    threads.append({"tid": int(tid), "main": tid == str(pid),
                                    "names": sorted(names[tid]),
                                    "membership": "observer" if tid in observed else "CLONE_THREAD ancestry",
                                    "counts": dict(counts.most_common()),
                                    "entered_calls": sum(counts.values()),
                                    "calls_per_second": sum(counts.values()) / row["seconds"],
                                    "errors": {name: dict(values) for name, values in sorted(errors.items())},
                                    "incomplete_calls": incomplete, "unmatched_resumes": unmatched,
                                    "syscall_wall_seconds_not_cpu": wall})
                roles[role] = {"pid": pid, "threads": threads, "missing_thread_logs": sorted(set(missing)),
                               "trace_complete": str(pid) in files and not missing,
                               "excluded_unmatched_logs": len(files.keys() - proven)}
            reports.append({"attempt": attempt["name"], "guards_accepted": attempt["accepted"],
                            "phase": row["name"], "start": start, "end": end, "roles": roles})
    value = {"kind": "syscall-count-diagnostic-not-cpu-ranking",
             "counting": "Entries inside the recorded phase; resumed calls retain their entry timestamp. Errors are syscall errno/restart codes.",
             "limitations": "-T includes waiting, descheduling and ptrace overhead, not syscall CPU. Provider/tracer CPU and provider syscall counts are excluded. Tracing can change behavior; unchanged quality guards must pass.",
             "reports": reports}
    save(output / "syscall-counts.json", value)
    return value


def place_tracers(output, receipt, placed):
    for runtime in (output / "run").glob("*/runtime.json"):
        try:
            apps = json.loads(runtime.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        for role in ["daemon", "viewer"]:
            pid = apps.get(role)
            if not pid or str(pid) in placed:
                continue
            try:
                fields = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines())
                tracer = int(fields["TracerPid"].strip())
                if not tracer:
                    continue
                executable = Path(f"/proc/{tracer}/exe").resolve()
                argv = Path(f"/proc/{tracer}/cmdline").read_bytes().split(b"\0")
                prefix = str(output.resolve() / "traces" / role).encode()
                if executable != Path(receipt["strace"]).resolve() or prefix not in argv:
                    raise ValueError("Application tracer is not this diagnostic's strace process")
                before = sorted(os.sched_getaffinity(tracer))
                tids = [int(task.name) for task in Path(f"/proc/{tracer}/task").iterdir()]
                for tid in tids:
                    os.sched_setaffinity(tid, {0})
                if any(os.sched_getaffinity(tid) != {0} for tid in tids):
                    raise ValueError("Tracer affinity did not stick")
                placed[str(pid)] = {"role": role, "app_pid": pid, "tracer_pid": tracer,
                                    "tracer_tids": tids, "at": time.time(),
                                    "before_cpus": before, "after_cpus": [0],
                                    "app_cpus_unchanged": fields["Cpus_allowed_list"].strip(),
                                    "executable": str(executable)}
                save(output / "tracer-placement.json", placed)
            except (FileNotFoundError, ProcessLookupError):
                continue


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--parent", type=Path, default=Path("/tmp/v6-harness-frozen-observer5-user-system"))
    parser.add_argument("--herdr", type=Path, default=Path("/home/t/dev/personal/herdr-cpu-benchmark/herdr-v0.9.5"))
    parser.add_argument("--seconds", type=float, default=10)
    parser.add_argument("--warmup", type=float, default=120)
    parser.add_argument("--node", type=int, choices=[0, 1], default=0)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--summarize-only", action="store_true")
    args = parser.parse_args()
    if args.summarize_only:
        summarize(args.output)
        return
    receipt = prepare(args.parent, args.output, args.binary, args.herdr, args.seconds, args.warmup, args.node)
    print(json.dumps(receipt), flush=True)
    if args.prepare_only:
        return
    placed = {}
    with (args.output / "observer.log").open("w") as log:
        child = subprocess.Popen(receipt["command"], stdout=log, stderr=subprocess.STDOUT)
        os.sched_setaffinity(0, {0})
        try:
            while child.poll() is None:
                place_tracers(args.output, receipt, placed)
                time.sleep(0.25)
            code = child.returncode
        except BaseException:
            child.terminate()
            raise
    if code:
        raise SystemExit(code)
    report = summarize(args.output)
    if not report["reports"] or not all(role["trace_complete"] for phase in report["reports"] for role in phase["roles"].values()):
        raise SystemExit("Missing actual application thread trace logs")
    if not all(str(role["pid"]) in placed for phase in report["reports"] for role in phase["roles"].values()):
        raise SystemExit("Missing verified tracer placement")


if __name__ == "__main__":
    main()
