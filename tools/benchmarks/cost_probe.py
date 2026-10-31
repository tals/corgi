#!/usr/bin/env python3
"""Low-frequency observer around one already-pinned, lock-owning benchmark command."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import datetime
import collections
from cost_matrix import cpu_accounting, cpu_counters, cpu_list, load_between, read_json, status, native_maps, sha
from cost_host import frequencies, frequency_policy, population
import cost_clamp


def threads(pid):
    result = {}
    try:
        for task in Path(f"/proc/{pid}/task").iterdir():
            try:
                raw = (task / "stat").read_text()
                fields = raw[raw.rfind(")") + 2:].split()
                result[task.name] = dict(name=raw[raw.find("(") + 1:raw.rfind(")")],
                                         ticks=int(fields[11]) + int(fields[12]), cpu=int(fields[36]),
                                         user_ticks=int(fields[11]), system_ticks=int(fields[12]))
            except (FileNotFoundError, ProcessLookupError):
                pass
    except (FileNotFoundError, ProcessLookupError):
        pass
    return result

output = Path(sys.argv[1]).resolve()
command = sys.argv[2:]
if command and command[0] == "--":
    command.pop(0)
clamped = os.environ.get('CPU_PROBE_UCLAMP') == '1'
if clamped:
    command = ['uclampset', '-m', '1024', '-M', '1024', *command]
output.mkdir(parents=True, exist_ok=True)
selected = cpu_list(os.environ.get("CPU_PROBE_CPUS", "8-15"))
siblings = set().union(*(cpu_list(Path(f"/sys/devices/system/cpu/cpu{cpu}/topology/thread_siblings_list").read_text()) for cpu in selected)) - selected
os.sched_setaffinity(0, {min(os.sched_getaffinity(0) - selected - siblings)})
observer_clamps = cost_clamp.task(os.getpid()) if clamped else None
if clamped and not cost_clamp.natural(observer_clamps):
    raise RuntimeError('The probe observer must retain natural utilization clamps')
host_before = population()
policy_before = frequency_policy(selected | siblings)
before = previous = cpu_counters()
samples, loaded, executables = [], {}, {}
clamps, next_clamp_snapshot = [], 0
with (output / "run.log").open("w") as log:
    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    while child.poll() is None:
        counters = cpu_counters()
        runtime = read_json(output / "runtime.json")
        now = time.time()
        if clamped and now >= next_clamp_snapshot:
            roots = [child.pid, *(runtime[role] for role in ['daemon', 'viewer'] if runtime.get(role))]
            clamps.append(cost_clamp.snapshot(roots))
            next_clamp_snapshot = now + 1
        for role in ['daemon', 'viewer']:
            pid = runtime.get(role)
            if pid and role not in executables:
                try:
                    executables[role] = sha(Path(f'/proc/{pid}/exe'))
                except (FileNotFoundError, ProcessLookupError):
                    pass
            if pid and len(loaded.get(role, {})) < 2:
                loaded[role] = native_maps(pid)
        samples.append(dict(selected_busy=load_between(previous, counters, selected),
                            frequency_khz=frequencies(selected | siblings), time=time.time(), siblings=load_between(previous, counters, siblings),
                            daemon=status(runtime["daemon"]) if runtime.get("daemon") else None,
                            viewer=status(runtime["viewer"]) if runtime.get("viewer") else None,
                            daemon_threads=threads(runtime["daemon"]) if runtime.get("daemon") else {},
                            viewer_threads=threads(runtime["viewer"]) if runtime.get("viewer") else {}))
        previous = counters
        time.sleep(0.5)
after = cpu_counters()
load = load_between(before, after, selected | siblings)
metadata = dict(population_before=host_before, population_after=population(),
                cpu_accounting=cpu_accounting,
                uclamp=dict(requested_min=1024, requested_max=1024) if clamped else None,
                observer_clamps=observer_clamps, clamp_snapshots=clamps,
                frequency_policy_before=policy_before, frequency_policy_after=frequency_policy(selected | siblings),
                native_maps=loaded, executable_sha256=executables, command=command, returncode=child.returncode, selected=sorted(selected), siblings=sorted(siblings),
                load=load, max_sibling_busy=max(load[cpu] for cpu in siblings), samples=samples)
thread_phases = []
for row in read_json(output / "results.json").get("results", []):
    start = datetime.datetime.fromisoformat(row["started_at"].replace("Z", "+00:00")).timestamp()
    window = [sample for sample in samples if start <= sample["time"] <= start + row["seconds"]]
    if clamped:
        in_phase = [sample for sample in clamps if start <= sample['time'] <= start + row['seconds']]
        required = [runtime[role] for role in ['daemon', 'viewer'] if runtime.get(role) and (role == 'daemon' or row.get('viewer_cpu') is not None)]
        metadata.setdefault('phase_clamps', []).append(dict(name=row['name'], snapshots=len(in_phase),
            verified=bool(in_phase) and all(sample['verified'] and all(pid in sample['processes'] for pid in required) for sample in in_phase)))
    if len(window) < 2:
        continue
    first, last = window[0], window[-1]
    elapsed = last["time"] - first["time"]
    roles = {}
    for role in ["daemon", "viewer"]:
        before_threads, after_threads = first[role + "_threads"], last[role + "_threads"]
        groups = collections.defaultdict(float)
        user_groups, system_groups = collections.defaultdict(float), collections.defaultdict(float)
        for tid in before_threads.keys() & after_threads.keys():
            value = after_threads[tid]
            groups[value["name"]] += 100 * (value["ticks"] - before_threads[tid]["ticks"]) / (os.sysconf("SC_CLK_TCK") * elapsed)
            user_groups[value["name"]] += 100 * (value["user_ticks"] - before_threads[tid]["user_ticks"]) / (os.sysconf("SC_CLK_TCK") * elapsed)
            system_groups[value["name"]] += 100 * (value["system_ticks"] - before_threads[tid]["system_ticks"]) / (os.sysconf("SC_CLK_TCK") * elapsed)
        roles[role] = dict(cpu_percent=dict(sorted(groups.items(), key=lambda item: -item[1])),
                           user_cpu_percent=dict(sorted(user_groups.items())),
                           system_cpu_percent=dict(sorted(system_groups.items())),
                           changed_threads=sorted(before_threads.keys() ^ after_threads.keys()))
    thread_phases.append(dict(name=row["name"], seconds=elapsed, **roles))
(output / "threads.json").write_text(json.dumps(dict(
    cpu_accounting=cpu_accounting,
    note="Per-thread CPU over inner 0.5s observation boundaries; only threads alive at both endpoints. Percentages include user+system time;100%=one core.",
    phases=thread_phases), indent=2) + "\n")
(output / "host.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(json.dumps({key: value for key, value in metadata.items() if key in ["command", "returncode", "selected", "siblings", "max_sibling_busy"]}))
sys.exit(child.returncode)
