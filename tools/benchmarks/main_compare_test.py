"""Synthetic pair receipts and mocked subprocesses only; no application workloads."""

import argparse
import contextlib
import copy
import datetime
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import main_compare as paired


START = 1800000000


def stamp(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()


def source(contract, case, role, start=START, warmup=30, seconds=60):
    count, workload = case.split("/")[-1].split("-")
    prefix = "idle" if workload == "idle" else "streaming"
    daemon = 4.0 if role == "main" else 2.0
    viewer = 2.0 if role == "main" else 1.0
    rows = []
    for index, attached in enumerate([True, False]):
        rows.append(dict(name=f'{prefix}-agents-{"viewer" if attached else "detached"}',
                         viewer_pid=100 if attached else None, viewer_cpu=viewer if attached else None,
                         daemon_cpu=daemon, daemon_child_cpu=0.5,
                         daemon_user_cpu=daemon / 2, daemon_system_cpu=daemon / 2,
                         daemon_child_user_cpu=0.25, daemon_child_system_cpu=0.25,
                         viewer_user_cpu=viewer / 2 if attached else None,
                         viewer_system_cpu=viewer / 2 if attached else None,
                         started_at=stamp(start + warmup + index * (warmup + seconds)),
                         seconds=seconds, warmup=warmup, affinity_verified=True, clamps_verified=True,
                         max_measured_sibling_busy=0.001, selected_busy_weighted_observed_khz=3000000))
    flags = ["complete", "producers_verified", "settings_verified", "idle_verified", "embedded_native_verified",
             "executable_verified", "affinity_verified", "clamps_verified", "measured_sibling_guard_passed", "clean",
             "accepted", "quality_pass", "strict_environment_pass"]
    binary = contract["binaries"][role]
    return dict(status="complete", agents=int(count), workload=workload, scenario="default",
                started_at=stamp(start), measurement_protocol="single-v4", noise_policy="strict", sibling_mean_limit=0.02,
                seconds=seconds, warmup=warmup, initial_warmup=warmup, stream_mode="sparse",
                producer_schedule="staggered", matched_geometry=True, native_override=None,
                uclamp=dict(requested_min=1024, requested_max=1024), binaries=dict(corgi=binary),
                harnesses={"cost_matrix.py": contract["sources"]["tools/benchmarks/cost_matrix.py"]},
                attempts=[dict(name=f'corgi-node{contract["node"]}-try1', **{k: True for k in flags},
                               max_sibling_busy=0.001, node=contract["node"], cpus=contract["cpus"], results=rows,
                               executable_sha256=dict(daemon=binary["sha256"], viewer=binary["sha256"]),
                               native_receipt=dict(expected=binary["build"]["nativeSHA256"]),
                               command=["numactl", f'--membind={contract["node"]}'])])


def leg(directory, contract, case, role, start=START, warmup=30, seconds=60):
    path = directory / case / role
    path.mkdir(parents=True, exist_ok=True)
    paired.save(path / "comparison.json", source(contract, case, role, start, warmup, seconds))
    paired.save(paired.execution_path(directory, case, role),
                dict(started_at=stamp(start), finished_at=stamp(start + 2 * (warmup + seconds)),
                     elapsed_seconds=2 * (warmup + seconds), returncode=0,
                     source_sha256=paired.sha(path / "comparison.json")))


def fixture(directory, cases, node=0, cpus="48-55"):
    directory.mkdir()
    sources = {"tools/benchmarks/cost_matrix.py": "frozen harness"}
    hashes = {}
    for name, content in sources.items():
        p = directory / "source" / name
        p.parent.mkdir(parents=True)
        p.write_text(content)
        hashes[name] = paired.sha(p)
    binaries = {}
    for role in paired.ROLES:
        build = dict(testBuild=False, sha256=role, releaseCommit="base" if role == "main" else "candidate",
                     nativeSHA256="native-" + role)
        paired.save(directory / f"{role}.build.json", build)
        binaries[role] = dict(path=role, sha256=role, build=build, build_sha256=paired.sha(directory / f"{role}.build.json"))
    paired.save(directory / "placement.json", dict(status="selected", selection=dict(node=node, cpus=cpus)))
    contract = dict(binaries=binaries, main_base="base", sources=hashes, settings=copy.deepcopy(paired.SETTINGS),
                    diagnostics=copy.deepcopy(paired.DIAGNOSTICS), node=node, cpus=cpus,
                    placement_sha256=paired.sha(directory / "placement.json"), cases=cases,
                    orders={case: paired.order(case) for case in cases}, preflight=["64-idle", "64-busy"])
    paired.save(directory / "plan.json", dict(schema="corgi-main-compare-plan-v1", contract=contract))
    clock = START - 200
    for case in contract["preflight"]:
        for role in paired.order(case):
            leg(directory, contract, "preflight/" + case, role, clock, 3, 3)
            clock += 20
    for case in cases:
        for index, role in enumerate(paired.order(case)):
            leg(directory, contract, case, role, START + index * 200)
    return contract


def change_source(directory, case, role, edit):
    p = directory / case / role / "comparison.json"
    value = paired.read(p)
    edit(value)
    paired.save(p, value)
    receipt = paired.execution_path(directory, case, role)
    execution = paired.read(receipt)
    execution["source_sha256"] = paired.sha(p)
    paired.save(receipt, execution)


class MainCompareTest(unittest.TestCase):
    def test_subset_order_uses_full_matrix_indices(self):
        self.assertEqual(paired.selection("64,8", "busy,idle"), ["8-idle", "8-busy", "64-idle", "64-busy"])
        self.assertEqual(paired.order("8-idle"), ["candidate", "main"])
        self.assertEqual(paired.order("64-busy"), ["main", "candidate"])
        self.assertEqual([paired.order(c)[0] for c in paired.selection("4,8,32,64", "idle,busy")],
                         ["main", "candidate", "candidate", "main", "main", "candidate", "candidate", "main"])

    def test_pair_accounting_preserves_children_and_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root / "run", ["4-idle"])
            change_source(root / "run", "4-idle", "candidate",
                          lambda s: s["attempts"][0]["results"][0].update(selected_busy_weighted_observed_khz=2000000))
            rows = paired.report(root / "report", [root / "run"])
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["main"]["total_cpu"], 6)
            self.assertEqual(rows[0]["candidate"]["total_cpu"], 3)
            self.assertEqual(rows[0]["candidate_minus_main_percentage_points"]["total_cpu"], -3)
            self.assertEqual(rows[0]["candidate_reduction_percent"]["daemon_cpu"], 50)
            self.assertEqual(rows[0]["candidate"]["daemon_waited_child_cpu"], .5)
            self.assertIsNone(rows[1]["main"]["viewer_cpu"])
            self.assertIsNone(rows[1]["candidate_reduction_percent"]["viewer_cpu"])
            self.assertEqual(rows[0]["window_start_separation_seconds"], 200)
            self.assertEqual(len(rows[0]["diagnostic_flags"]), 1)
            summary = paired.read(root / "report/summary.json")
            self.assertEqual(summary["pairs"][0]["inter_leg_gap_seconds"], 20)
            self.assertTrue(summary["preflight_excluded"])
            self.assertEqual(summary["missing_pairs"], [])

    def test_merge_requires_whole_pairs_from_one_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ["left", "right", "replacement"]:
                fixture(root / name, ["4-idle"], node=1 if name == "replacement" else 0,
                        cpus="104-111" if name == "replacement" else "48-55")
            for name, missing in [("left", "candidate"), ("right", "main")]:
                (root / name / "4-idle" / missing / "comparison.json").unlink()
            self.assertEqual(paired.report(root / "partial", [root / "left", root / "right"]), [])
            self.assertEqual(paired.read(root / "partial/summary.json")["missing_pairs"], ["4-idle"])
            rows = paired.report(root / "full", [root / "left", root / "replacement"])
            self.assertEqual(len(rows), 2)
            self.assertTrue(all(r["node"] == 1 for r in rows))
            with self.assertRaisesRegex(ValueError, "Duplicate complete pair"):
                paired.report(root / "duplicate", [root / "replacement", root / "replacement"])

    def test_rejects_noise_settings_identity_placement_and_changed_sources(self):
        mutations = [
            (lambda s: s.update(noise_policy="diagnostic"), "Trial settings differ"),
            (lambda s: s.update(seconds=3), "Trial settings differ"),
            (lambda s: s["binaries"]["corgi"].update(sha256="different"), "Binary differs"),
            (lambda s: s["attempts"][0].update(cpus="56-63"), "Placement differs"),
            (lambda s: s["attempts"][0].update(command=["numactl", "--membind=1"]), "Memory binding differs"),
            (lambda s: s["attempts"][0]["results"].pop(), "Incomplete phases"),
            (lambda s: s["attempts"][0]["results"][0].update(seconds=59), "Phase differs"),
            (lambda s: s["attempts"][0]["results"][0].update(daemon_cpu=99), "does not reconcile"),
        ]
        for mutation, message in mutations:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                fixture(root / "run", ["4-idle"])
                change_source(root / "run", "4-idle", "candidate", mutation)
                with self.assertRaisesRegex(ValueError, message):
                    paired.report(root / "report", [root / "run"])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root / "run", ["4-idle"])
            change_source(root / "run", "4-idle", "candidate",
                          lambda s: s["attempts"][0].update(strict_environment_pass=False))
            self.assertEqual(paired.report(root / "report", [root / "run"]), [])
            (root / "run/source/tools/benchmarks/cost_matrix.py").write_text("changed")
            with self.assertRaisesRegex(ValueError, "Frozen harness copy"):
                paired.report(root / "report", [root / "run"])

    def test_submillisecond_timer_rounding_uses_actual_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root / "run", ["4-idle"])
            change_source(root / "run", "4-idle", "candidate",
                          lambda s: s["attempts"][0]["results"][0].update(seconds=59.9995))
            rows = paired.report(root / "report", [root / "run"])
            self.assertEqual(rows[0]["candidate"]["seconds"], 59.9995)

    def test_missing_preflight_changed_contract_and_overlap_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture(root / "one", ["4-idle"])
            fixture(root / "two", ["8-idle"])
            planpath = root / "two/plan.json"
            plan = paired.read(planpath)
            plan["contract"]["binaries"]["main"]["sha256"] = "different"
            paired.save(planpath, plan)
            with self.assertRaisesRegex(ValueError, "Cannot merge changed binaries"):
                paired.report(root / "report", [root / "one", root / "two"])
            receipt = paired.execution_path(root / "one", "4-idle", "candidate")
            execution = paired.read(receipt)
            execution["started_at"] = stamp(START + 100)
            paired.save(receipt, execution)
            with self.assertRaisesRegex(ValueError, "overlap"):
                paired.report(root / "report", [root / "one"])
            execution["started_at"] = stamp(START + 200)
            paired.save(receipt, execution)
            (root / "one/preflight/64-busy/main/comparison.json").unlink()
            with self.assertRaisesRegex(ValueError, "preflights"):
                paired.report(root / "report", [root / "one"])

    def test_runner_freezes_preflights_resumes_and_preserves_failed_leg(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for role in paired.ROLES:
                binary = root / role
                binary.write_bytes(role.encode())
                paired.save(Path(str(binary) + ".build.json"), dict(testBuild=False, sha256=paired.sha(binary),
                            releaseCommit="base" if role == "main" else "candidate", nativeSHA256="native-" + role))
            pilot = root / "pilot.json"
            paired.save(pilot, dict(status="selected", selection=dict(node=0, cpus="48-55")))
            args = argparse.Namespace(main=root / "main", candidate=root / "candidate", output=root / "run",
                                      node=0, cpus="48-55", placement_receipt=pilot, counts="8", workloads="idle,busy",
                                      preflight_only=True, resume=False, warmup=30, seconds=60)
            calls, clock = [], [START]

            def execute(command, **_kwargs):
                path = Path(command[4])
                role, case = path.name, path.parent.name
                warmup, seconds = [int(command[command.index(flag) + 1]) for flag in ("--warmup", "--seconds")]
                plan = paired.read(args.output / "plan.json")["contract"]
                self.assertEqual(paired.sha(args.output / "source/tools/benchmarks/main_compare.py"),
                                 plan["sources"]["tools/benchmarks/main_compare.py"])
                self.assertEqual(command[2], command[3])
                self.assertIn("--single-corgi", command)
                self.assertIn("--uclamp", command)
                path.mkdir()
                paired.save(path / "comparison.json", source(plan, case, role, clock[0], warmup, seconds))
                calls.append((case, role, seconds))
                clock[0] += 2 * (warmup + seconds) + 5
                return argparse.Namespace(returncode=0)

            def timestamp():
                clock[0] += 1
                return stamp(clock[0])

            with patch.object(paired.corgi_costs, "topology", return_value=dict(selected=list(range(48, 56)), cpus="48-55")), \
                    patch.object(paired.subprocess, "check_output", return_value="base\n"), \
                    patch.object(paired.subprocess, "run", side_effect=execute), \
                    patch.object(paired, "now", side_effect=timestamp), contextlib.redirect_stdout(io.StringIO()):
                paired.run(args)
                self.assertEqual(calls, [("64-idle", "candidate", 3), ("64-idle", "main", 3),
                                         ("64-busy", "main", 3), ("64-busy", "candidate", 3)])
                args.resume, args.preflight_only = True, False
                paired.run(args)
                self.assertEqual(calls[4:], [("8-idle", "candidate", 60), ("8-idle", "main", 60),
                                            ("8-busy", "main", 60), ("8-busy", "candidate", 60)])
                paired.run(args)
                self.assertEqual(len(calls), 8)
                change_source(args.output, "8-busy", "candidate", lambda s: s.update(status="incomplete due to sibling load"))
                rejected = args.output / "8-busy/candidate/comparison.json"
                before = rejected.read_bytes()
                with self.assertRaisesRegex(ValueError, "Preserved incomplete leg"):
                    paired.run(args)
                self.assertEqual(len(calls), 8)
                self.assertEqual(rejected.read_bytes(), before)
                args.counts = "4"
                with self.assertRaisesRegex(ValueError, "unchanged plan"):
                    paired.run(args)


if __name__ == "__main__":
    unittest.main()
