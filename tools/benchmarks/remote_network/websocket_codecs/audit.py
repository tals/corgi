#!/usr/bin/env python3
"""Reduce four-arm application trials and audit the WebSocket transport controls."""

import argparse
import collections
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

LABELS = {
    "before": "WS uncompressed",
    "after": "WS zstd",
    "control": "WS native deflate",
    "herdr": "Stock Herdr + SSH-C",
}
HERE = Path(__file__).resolve().parent


def load(path):
    return json.loads(path.read_text())


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--builds",
        type=Path,
        help="Prototype builds.json; defaults to the WebSocket binary's directory",
    )
    parser.add_argument(
        "--partial",
        action="store_true",
        help="Inspect completed labs without claiming the matrix is complete",
    )
    args = parser.parse_args()
    root, out = args.root.resolve(), args.output.resolve()
    plan = load(root / "plan.json")
    suites, repeats = plan["suites"].split(","), plan["repeats"]
    expected = {
        (suite, f"{label}-{repeat}")
        for suite in suites
        for label in LABELS
        for repeat in range(1, repeats + 1)
    }
    out.mkdir(parents=True, exist_ok=True)
    report = HERE.parent / "adaptive_report.py"
    # Its standard checks apply to every label. Only its three-label count is inapplicable.
    with (out / "standard-report.log").open("w") as log:
        subprocess.run(
            [sys.executable, str(report), str(root), str(out), "--partial"],
            check=True,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    shutil.copy2(out / "audit.json", out / "audit-standard.json")
    standard = load(out / "audit-standard.json")
    summary, trials = load(out / "summary.json"), load(out / "trials.json")
    checks, problems = list(standard["checks"]), list(standard["problems"])

    def check(condition, text):
        (checks if condition else problems).append(text)

    check(
        repeats == 3, "plan schedules three independent repetitions per arm and suite"
    )
    actual = {
        (Path(trial["path"]).parent.name, Path(trial["path"]).name) for trial in trials
    }
    check(actual <= expected, "every retained lab belongs to the four-arm plan")
    if not args.partial:
        check(
            actual == expected,
            f"all {len(expected)} scheduled labs are complete; found {len(actual)}",
        )
        manifests = {
            (path.parent.parent.name, path.parent.name)
            for path in root.glob("*/*/manifest.json")
        }
        check(
            manifests == expected, "manifest set exactly matches the scheduled matrix"
        )
    for group in summary:
        # Suite is part of the key: startup observations from different suites stay separate.
        if not args.partial:
            check(
                len(set(group["evidence"])) == repeats,
                "three distinct trials for group " + json.dumps(group["key"]),
            )
            check(
                group["n"]
                == repeats
                * (
                    3
                    if group["key"][2] == "navigation"
                    and group["key"][-1] == "uncached"
                    else 1
                ),
                "scheduled measurements per trial for group "
                + json.dumps(group["key"]),
            )
    if not args.partial:
        arms = collections.defaultdict(set)
        for group in summary:
            key = group["key"]
            arms[tuple([key[0], *key[2:]])].add(key[1])
        for key, labels_present in sorted(arms.items(), key=lambda pair: str(pair[0])):
            check(
                labels_present == set(LABELS),
                "all four arms for scheduled group " + json.dumps(key),
            )
    failures = [str(path) for path in root.glob("*/*/failure.txt")]
    check(not failures, "no runner failure artifacts")

    starts, exits = collections.defaultdict(list), collections.defaultdict(list)
    for event in lines(root / "execution.jsonl"):
        key = event["suite"], event["name"]
        (starts if event["event"] == "start" else exits)[key].append(event)
    for key in sorted(actual):
        name = "/".join(key)
        check(len(starts[key]) == 1, name + ": one invocation retained")
        check(
            len(exits[key]) == 1 and exits[key][0]["code"] == 0,
            name + ": successful recorded process exit",
        )
    if not args.partial:
        check(
            set(starts) == expected and set(exits) == expected,
            "execution records exactly cover all scheduled labs",
        )
        codes = (
            load(root / "exit-codes.json")
            if (root / "exit-codes.json").exists()
            else []
        )
        check(
            len(codes) == len(expected) and all(code == 0 for code in codes),
            f"all {len(expected)} matrix exit codes are zero",
        )

    labels = {}
    for label, description in LABELS.items():
        binary = Path(plan[label]).resolve()
        labels[label] = {
            "description": description,
            "binary": str(binary),
            "sha256": sha(binary),
        }
    builds_path = args.builds or Path(labels["after"]["binary"]).parent / "builds.json"
    builds = load(builds_path)
    modes = {"before": "identity", "after": "zstd", "control": "deflate"}
    patches = {}
    for mode in [*modes.values(), "zstd-raw"]:
        patch = builds_path.parent / (mode + ".patch")
        check(
            sha(patch) == builds[mode]["patch_sha256"],
            mode + ": retained patch identity",
        )
        check(
            sha(Path(builds[mode]["binary"])) == builds[mode]["sha256"],
            mode + ": retained binary identity",
        )
        text = patch.read_text()
        patches[mode] = text
        for name in ["eval_transport.ts", "eval_inspect.ts"]:
            section = text.split("+++ b/src/" + name + "\n", 1)[-1].split(
                "\ndiff --git ", 1
            )[0]
            source = (
                "\n".join(
                    line[1:] for line in section.splitlines() if line.startswith("+")
                )
                + "\n"
            )
            frozen = "adapter.ts" if name == "eval_transport.ts" else "inspect.ts"
            check(
                source == (root / "harness" / frozen).read_text(),
                mode + ": compiled " + frozen + " matches frozen source",
            )
    normalized = {
        mode: "\n".join(
            line
            for line in text.splitlines()
            if not line.startswith("index ")
            and not line.startswith("+export const eval")
        )
        for mode, text in patches.items()
    }
    check(
        len(set(normalized.values())) == 1,
        "all four patches differ only in codec/accounting selection constants",
    )
    check(
        len({build["build"]["nativeSHA256"] for build in builds.values()}) == 1,
        "identical native layer across variants",
    )
    for label, mode in modes.items():
        check(
            labels[label]["sha256"] == builds[mode]["sha256"],
            label + ": correct mode binary",
        )
        labels[label].update(
            build=builds[mode]["build"], patch_sha256=builds[mode]["patch_sha256"]
        )
    topology = load(root / "cpu-topology.json")
    allocated = set(
        range(
            plan["cpu_start"],
            plan["cpu_start"] + 4 * plan["cpus_per_lab"] * len(suites),
        )
    )
    cores = [(core, socket) for cpu, core, socket in topology if cpu in allocated]
    check(
        len(set(cores)) == len(allocated),
        "concurrent labs have disjoint physical cores, including SMT siblings",
    )

    transport_evidence = []
    for trial in trials:
        path, label = Path(trial["path"]), trial["label"]
        name = str(path.relative_to(root))
        manifest = load(path / "manifest.json")
        repeat = int(path.name.rsplit("-", 1)[1]) - 1
        slot = (list(LABELS).index(label) + repeat) % 4
        first_cpu = (
            plan["cpu_start"]
            + (suites.index(path.parent.name) * 4 + slot) * plan["cpus_per_lab"]
        )
        expected_cpus = f"{first_cpu}-{first_cpu + plan['cpus_per_lab'] - 1}"
        check(
            manifest["args"]["cpus"] == expected_cpus,
            name + ": planned rotating CPU assignment",
        )
        check(
            not manifest["args"].get("trace") and not manifest["args"].get("capture"),
            name + ": timed trial has no diagnostic trace or packet capture",
        )
        check(
            manifest["sha256"]
            == (
                builds["zstd-raw"]["sha256"]
                if path.parent.name.startswith("accounting-") and label == "after"
                else labels[label]["sha256"]
            ),
            name + ": correct binary for arm",
        )
        check(
            manifest["args"]["ssh_compression"] == "default",
            name + ": harness does not override product SSH compression",
        )
        commands, product_machines, separate_adapters = set(), set(), set()
        for sample in lines(path / "resources.jsonl"):
            for process in sample["processes"]:
                command = process["command"]
                if command.startswith(manifest["binary"] + " "):
                    product_machines.add(process["machine"])
                if command.startswith("/usr/bin/ssh ") or command.startswith("ssh "):
                    commands.add(command)
                if "adapter.ts" in command or "eval_transport.ts" in command:
                    separate_adapters.add(command)
        check(
            product_machines == {"local", "atlas", "borealis"},
            name + ": CPU sampler includes all product machines",
        )
        check(
            not separate_adapters,
            name + ": no separate adapter runtime omitted from product CPU",
        )
        evidence = {
            "lab": name,
            "ssh_log_paths": [],
            "product_machines": sorted(product_machines),
        }
        if label == "herdr":
            check(
                bool(commands) and all("-C" in command.split() for command in commands),
                name + ": stock Herdr requests SSH compression",
            )
        else:
            profiles = load(path / "machines.json")["machines"]
            for machine in ["atlas", "borealis"]:
                profile = next(
                    (profile for profile in profiles if profile["name"] == machine), {}
                )
                bridge = profile.get("bridge")
                check(
                    bool(bridge),
                    name + f": {machine} profile uses the native SSH bridge",
                )
                log_path = path / f"ssh-commands-{machine}.log"
                evidence["ssh_log_paths"].append(str(log_path))
                recorded = [
                    line
                    for line in log_path.read_text().splitlines()
                    if bridge and bridge in line
                ]
                suffix = ".transport"
                target = profile.get("socket", "") + suffix
                check(
                    bool(recorded) and all(target in line for line in recorded),
                    name
                    + f": {machine} bridge reaches {'adapter' if suffix else 'direct daemon'} socket",
                )
                live = [command for command in commands if bridge and bridge in command]
                check(
                    bool(live) and all("Compression=no" in command for command in live),
                    name + f": {machine} stream avoids stacked SSH compression",
                )
        transport_evidence.append(evidence)

    audit = {
        **standard,
        "checks_passed": len(checks),
        "checks": checks,
        "problems": problems,
        "labs": len(trials),
        "expected_labs": len(expected),
        "partial": args.partial,
        "labels": LABELS,
        "expected_repetitions": repeats,
        "standard_audit": "audit-standard.json",
        "standard_count_note": "Shared reducer is intentionally invoked with --partial; its three-arm expected count is superseded by this four-arm plan count.",
        "reducer_sha256": sha(report),
        "audit_script_sha256": sha(Path(__file__)),
        "builds": str(builds_path),
        "transport_evidence": transport_evidence,
        "failure_artifacts": failures,
        "limitations": [
            "No WebSocket daemon handoff or TCP half-close claim",
            "CPU measures product processes, including adapters, but excludes SSH and kernel CPU",
        ],
    }
    (out / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    (out / "labels.json").write_text(json.dumps(labels, indent=2) + "\n")
    print(
        json.dumps(
            {
                "labs": len(trials),
                "expected_labs": len(expected),
                "groups": len(summary),
                "checks": len(checks),
                "partial": args.partial,
                "problems": problems,
            }
        )
    )
    return bool(problems)


if __name__ == "__main__":
    sys.exit(main())
