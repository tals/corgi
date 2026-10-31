#!/usr/bin/env python3
"""Serial initialized-state memory ladder. OS snapshots precede the optional JSC heap walk."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import random
import re
import selectors
import subprocess
import time


MODES = ["empty", "native", "viewer", "controller0", "pane1", "metadata16", "visited16", "tiny"]


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def line(child, timeout=60):
    pending = getattr(child, "memory_pending", bytearray())
    child.memory_pending = pending
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        while True:
            at = pending.find(b"\n")
            if at >= 0:
                raw = bytes(pending[:at])
                del pending[:at + 1]
                return json.loads(raw)
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise TimeoutError("Memory subject response timeout")
            chunk = os.read(child.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError(f"Memory subject closed stdout (exit {child.poll()})")
            pending.extend(chunk)
            if len(pending) > 4 * 1024 * 1024:
                raise RuntimeError("Memory control response exceeded bound")
    finally:
        selector.close()


def smaps_groups(raw, executable):
    groups, current = {}, None
    for row in raw.splitlines():
        match = re.match(r"^[0-9a-f]+-[0-9a-f]+\s+\S+\s+\S+\s+\S+\s+\S+\s*(.*)$", row)
        if match:
            path = match[1]
            if path == executable:
                current = "executable"
            elif "libcorgi_term." in path:
                current = "terminal_dso"
            elif "libcorgi_system." in path:
                current = "system_dso"
            elif not path or path.startswith("["):
                current = "anonymous_or_kernel_named"
            else:
                current = "other_named_mappings"
            groups.setdefault(current, {})
        elif current:
            field = re.match(r"^(Rss|Pss|Private_Clean|Private_Dirty|Private_Hugetlb|Anonymous):\s+(\d+) kB$", row)
            if field:
                groups[current][field[1]] = groups[current].get(field[1], 0) + int(field[2])
    return groups


def children(pid):
    result = set()
    for task in Path(f"/proc/{pid}/task").iterdir():
        try:
            result.update(int(p) for p in (task / "children").read_text().split())
        except FileNotFoundError:
            pass
    return result


def cpu_snapshot():
    return Path("/proc/stat").read_text()


def cpu_set(value):
    result = set()
    for part in value.split(","):
        ends = [int(n) for n in part.split("-")]
        result.update(range(ends[0], ends[-1] + 1))
    return result


def host_context():
    result = {"at": time.time(), "processes": []}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            raw = (path / "stat").read_text()
            fields = raw[raw.rfind(")") + 2:].split()
            result["processes"].append({"pid": int(path.name), "name": raw[raw.find("(") + 1:raw.rfind(")")],
                                        "parent": int(fields[1]), "threads": int(fields[17]), "start_ticks": int(fields[19])})
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return result


def subject(command, directory, env):
    log = (directory / "stderr.log").open("w")
    try:
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=log, text=True, env=env, start_new_session=True)
    except BaseException:
        log.close()
        raise
    return child, log


def close(child, log):
    if child.poll() is None:
        try:
            child.stdin.write("close\n")
            child.stdin.flush()
            child.wait(timeout=10)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            # This process group contains only the owned subject. No system-wide cleanup.
            try:
                os.killpg(child.pid, 15)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, 9)
                except ProcessLookupError:
                    pass
                child.wait()
    try:
        child.stdin.close()
    except BrokenPipeError:
        pass
    child.stdout.close()
    log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path, help="Frozen memory builder output directory")
    parser.add_argument("output", type=Path, help="Fresh raw measurement directory")
    parser.add_argument("--age", type=float, default=30, help="Seconds after ready, same for every fresh subject")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--modes", nargs="+", choices=MODES, default=MODES,
                        help="Modes to measure; correctness still verifies every mode")
    parser.add_argument("--seed", type=int, default=20261026)
    parser.add_argument("--cpus", default="8-15")
    parser.add_argument("--node", type=int, default=0)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--release-hidden", action="store_true",
                        help="Exercise the subject's production mirror release policy")
    args = parser.parse_args()
    if args.age <= 0 or args.repeats < 1:
        parser.error("Positive age and repeats required")
    if args.output.exists():
        parser.error("Use a fresh output directory")
    if os.environ.get("CORGI_NATIVE_ROOT") or os.environ.get("CORGI_TELEMETRY_DIR"):
        parser.error("Unset native override and telemetry")
    jsc = {k: v for k, v in os.environ.items() if k.startswith("JSC_")}
    if jsc:
        parser.error("Use ordinary JSC settings, without JSC_* environment overrides")
    with open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.sched_setaffinity(0, {0})
        args.output.mkdir()
        build = json.loads((args.build / "build.json").read_text())
        (args.output / "runner.py.fixture").write_bytes(Path(__file__).read_bytes())
        (args.output / "build-receipt.json").write_bytes((args.build / "build.json").read_bytes())
        binaries = {key: Path(value["path"]) for key, value in build["binaries"].items()}
        for key, value in build["binaries"].items():
            if sha(binaries[key]) != value["sha256"]:
                raise RuntimeError("Memory subject binary hash changed")
        env = dict(os.environ)
        # The fixture producer also pre-extracts the exact embedded assets, outside subjects.
        fixture = (args.output / "surface.json").resolve()
        command_prefix = ["numactl", "--all", f"--physcpubind={args.cpus}", f"--membind={args.node}"]
        subject_flags = ["--release-hidden"] if args.release_hidden else []
        prepared = subprocess.run([*command_prefix, str(binaries["subject"]), "prepare", str(fixture)],
                                  env=env, text=True, capture_output=True, timeout=60)
        (args.output / "prepare.stdout").write_text(prepared.stdout)
        (args.output / "prepare.stderr").write_text(prepared.stderr)
        prepared.check_returncode()
        # Verification has its own processes and may allocate extra reference VTs.
        verified = {}
        for mode in MODES:
            binary = binaries["tiny" if mode == "tiny" else "subject"]
            result = subprocess.run([*command_prefix, str(binary), mode, str(fixture), "--verify", *subject_flags],
                                    env=env, text=True, capture_output=True, timeout=60)
            (args.output / f"verify-{mode}.stdout").write_text(result.stdout)
            (args.output / f"verify-{mode}.stderr").write_text(result.stderr)
            result.check_returncode()
            verified[mode] = json.loads(result.stdout)
        if verified["metadata16"]["surface_sha256"] != verified["visited16"]["surface_sha256"]:
            raise RuntimeError("Visiting hidden panes changed the final visible screen")
        orders, rng = [], random.Random(args.seed)
        for repeat in range(args.repeats):
            order = list(dict.fromkeys(args.modes))
            rng.shuffle(order)
            orders.append(order)
        save(args.output / "manifest.json", {
            "kind": "initialized-viewer-memory-ladder", "build": build,
            "builder_receipt_sha256": sha(args.build / "build.json"), "runner_sha256": sha(Path(__file__)),
            "fixture_sha256": sha(fixture), "age_after_ready_seconds": args.age,
            "orders": orders, "seed": args.seed, "cpus": args.cpus, "node": args.node,
            "ordinary_gc": True, "heap_walk_after_os_snapshots": True,
            "verified": verified, "verify_only": args.verify_only,
            "release_hidden": args.release_hidden,
            "limitations": "Quiescent initialized objects, not a production workload or leak test. File PSS can vary with unrelated processes sharing the same mappings. Anonymous memory includes runtime, JIT, allocator and native heaps. heapStats walks the heap; its values are not exact live ownership.",
        })
        if args.verify_only:
            return
        save(args.output / "host-before.json", host_context())
        summary = []
        for repeat, order in enumerate(orders):
            for mode in order:
                directory = args.output / f"{repeat}-{mode}"
                directory.mkdir()
                binary = binaries["tiny" if mode == "tiny" else "subject"]
                command = [*command_prefix, str(binary), mode, str(fixture), *subject_flags]
                launch_wall, launch_mono = time.time(), time.monotonic()
                before_cpu = cpu_snapshot()
                child, log = subject(command, directory, env)
                try:
                    ready = line(child)
                    ready_mono = time.monotonic()
                    ready_wall = time.time()
                    if ready.get("type") != "ready" or ready.get("pid") != child.pid or ready.get("mode") != mode:
                        raise RuntimeError("Unexpected memory subject identity")
                    if sha(Path(f"/proc/{child.pid}/exe")) != build["binaries"]["tiny" if mode == "tiny" else "subject"]["sha256"]:
                        raise RuntimeError("Running executable differs from frozen subject")
                    while time.monotonic() < ready_mono + args.age:
                        if child.poll() is not None:
                            raise RuntimeError("Memory subject exited during aging")
                        time.sleep(min(0.5, max(0, ready_mono + args.age - time.monotonic())))
                    if children(child.pid):
                        raise RuntimeError("Unexpected child process in static memory fixture")
                    captures = {}
                    for name in ["smaps", "smaps_rollup", "maps", "status", "numa_maps", "stat"]:
                        at = time.time()
                        age_at_start = time.monotonic() - ready_mono
                        raw = Path(f"/proc/{child.pid}/{name}").read_text()
                        (directory / name).write_text(raw)
                        captures[name] = {"started_at": at, "finished_at": time.time(),
                                          "age_at_start_seconds": age_at_start,
                                          "age_at_end_seconds": time.monotonic() - ready_mono}
                    maps = (directory / "maps").read_text()
                    status = dict(row.split(":", 1) for row in (directory / "status").read_text().splitlines())
                    if cpu_set(status["Cpus_allowed_list"].strip()) != cpu_set(args.cpus):
                        raise RuntimeError("Subject CPU placement differs from request")
                    task_status = {}
                    for task in Path(f"/proc/{child.pid}/task").iterdir():
                        try:
                            fields = dict(row.split(":", 1) for row in (task / "status").read_text().splitlines())
                            task_status[task.name] = {key: fields[key].strip() for key in ["Name", "Cpus_allowed_list", "Mems_allowed_list"]}
                            if not cpu_set(fields["Cpus_allowed_list"].strip()) <= cpu_set(args.cpus):
                                raise RuntimeError("Subject helper escaped requested CPU placement")
                        except FileNotFoundError:
                            pass
                    save(directory / "task-status.json", task_status)
                    native_paths = {row.split()[-1] for row in maps.splitlines() if "/libcorgi_" in row}
                    if mode in ["empty", "tiny"] and native_paths:
                        raise RuntimeError("Empty control unexpectedly loaded application native libraries")
                    if mode not in ["empty", "tiny"]:
                        for lib in ["libcorgi_term.so", "libcorgi_system.so"]:
                            paths = [Path(p) for p in native_paths if p.endswith(lib)]
                            if len(paths) != 1 or sha(paths[0]) != build["nativeFiles"]["lib/" + lib]:
                                raise RuntimeError("Loaded native asset hash mismatch")
                    age = time.monotonic() - ready_mono
                    child.stdin.write("stats\n")
                    child.stdin.flush()
                    stats = line(child)
                    if stats.get("type") != "stats" or stats.get("mode") != mode:
                        raise RuntimeError("Unexpected heap measurement response")
                    save(directory / "stats.json", stats)
                    (directory / "cpu-before.txt").write_text(before_cpu)
                    (directory / "cpu-after.txt").write_text(cpu_snapshot())
                    row = {"mode": mode, "repeat": repeat, "pid": child.pid, "command": command,
                           "launch_wall": launch_wall, "launch_to_ready_seconds": ready_mono - launch_mono,
                           "ready_wall": ready_wall,
                           "age_at_heap_request_seconds": age, "ready": ready, "captures": captures,
                           "native_maps": sorted(native_paths),
                           "rollup_kib": {match[1]: int(match[2]) for match in
                               re.finditer(r"^(\w+):\s+(\d+) kB$", (directory / "smaps_rollup").read_text(), re.MULTILINE)},
                           "mapping_groups_kib": smaps_groups((directory / "smaps").read_text(), str(binary))}
                    save(directory / "receipt.json", row)
                    summary.append(row)
                    save(args.output / "summary.json", summary)
                    print(json.dumps({"mode": mode, "repeat": repeat, "ready": ready, "groups_kib": row["mapping_groups_kib"]}), flush=True)
                finally:
                    close(child, log)
                if child.returncode != 0:
                    raise RuntimeError(f"Memory subject cleanup exited {child.returncode}")
        save(args.output / "host-after.json", host_context())
        save(args.output / "raw-manifest.json", {
            str(p.relative_to(args.output)): sha(p) for p in sorted(args.output.rglob("*"))
            if p.is_file() and p.name != "raw-manifest.json"
        })


if __name__ == "__main__":
    main()
