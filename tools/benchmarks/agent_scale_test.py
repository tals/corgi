"""Synthetic receipts only: these tests launch no application or CPU workload."""
import argparse
import contextlib
import copy
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent_scale


def trial(count=4, workload="idle", warmup=30, seconds=60):
    prefix = "idle" if workload == "idle" else "streaming"
    rows = [dict(name=f"{prefix}-agents-{name}", viewer_cpu=viewer, daemon_cpu=1.5,
                 daemon_child_cpu=0.1, seconds=seconds, warmup=warmup)
            for name, viewer in [("viewer", 0.5), ("detached", None)]]
    return dict(status="complete", agents=count, workload=workload, scenario="default",
                measurement_protocol="single-v4", noise_policy="strict", sibling_mean_limit=0.02,
                seconds=seconds, warmup=warmup, initial_warmup=warmup, stream_mode="sparse",
                producer_schedule="staggered", matched_geometry=True,
                uclamp=dict(requested_min=1024, requested_max=1024),
                binaries=dict(corgi=dict(sha256="binary")),
                attempts=[dict(name="corgi-node0-try1", accepted=True, quality_pass=True,
                               strict_environment_pass=True, max_sibling_busy=0.001, node=0,
                               cpus="32-39", results=rows)])


def fixture(path, cases, receipts):
    path.mkdir()
    agent_scale.save(path / "plan.json", dict(contract=dict(cases=cases, binary_sha256="binary")))
    for case, value in receipts.items():
        (path / case).mkdir(parents=True)
        agent_scale.save(path / case / "comparison.json", value)


class AgentScaleTest(unittest.TestCase):
    def test_acceptance_excludes_diagnostic_noise_and_partial_cases(self):
        self.assertIsNotNone(agent_scale.accepted(trial()))
        for field in ["accepted", "quality_pass", "strict_environment_pass"]:
            value = trial()
            value["attempts"][0][field] = False
            self.assertIsNone(agent_scale.accepted(value))
        value = trial()
        value["status"] = "measuring"
        self.assertIsNone(agent_scale.accepted(value))
        value = trial()
        value["attempts"].append(copy.deepcopy(value["attempts"][0]))
        self.assertIsNone(agent_scale.accepted(value))

    def test_report_combines_new_placement_without_rehabilitating_rejected_case(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rejected = trial(8)
            rejected["status"] = "incomplete due to sibling load"
            rejected["attempts"][0].update(accepted=False, strict_environment_pass=False)
            replacement = trial(8)
            replacement["attempts"][0].update(node=1, cpus="72-79")
            fixture(root / "first", ["4-idle", "8-idle"], {"4-idle": trial(), "8-idle": rejected})
            fixture(root / "next", ["8-idle"], {"8-idle": replacement})
            original = (root / "first/8-idle/comparison.json").read_bytes()
            rows = agent_scale.report(root / "report", [root / "first", root / "next"])
            self.assertEqual(len(rows), 4)
            self.assertEqual([row["node"] for row in rows], [0, 0, 1, 1])
            self.assertIsNone(rows[1]["viewer_cpu"])
            self.assertEqual(rows[0]["total_cpu"], 2.0)
            self.assertEqual(rows[0]["daemon_waited_child_cpu"], 0.1)
            self.assertEqual((root / "first/8-idle/comparison.json").read_bytes(), original)
            summary = agent_scale.read(root / "report/summary.json")
            self.assertEqual(len(summary["excluded"]), 1)
            self.assertEqual(summary["missing_cells"], [])
            agent_scale.report(root / "partial", [root / "first"])
            self.assertEqual(agent_scale.read(root / "partial/summary.json")["missing_cells"],
                             [[8, "idle", False], [8, "idle", True]])

    def test_report_rejects_duplicate_cells_and_changed_measurement_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root / "first", ["4-idle"], {"4-idle": trial()})
            with self.assertRaisesRegex(ValueError, "Duplicate accepted cell"):
                agent_scale.report(root / "report", [root / "first", root / "first"])
            for key, changed in [("seconds", 3), ("noise_policy", "diagnostic"), ("stream_mode", "scroll")]:
                value = trial()
                value[key] = changed
                with self.assertRaisesRegex(ValueError, "Trial settings differ"):
                    agent_scale.verify_source(value, dict(binary_sha256="binary"), "4-idle")

    def test_runner_preflights_once_resumes_and_never_skips_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "binary"
            binary.write_bytes(b"frozen")
            digest = agent_scale.sha(binary)
            agent_scale.save(Path(str(binary) + ".build.json"), dict(testBuild=False, sha256=digest))
            pilot = root / "pilot.json"
            agent_scale.save(pilot, dict(selection=dict(node=0, cpus="32-39")))
            args = argparse.Namespace(binary=binary, output=root / "matrix", node=0, cpus="32-39",
                                      placement_receipt=pilot, counts="4", workloads="idle,busy",
                                      preflight_only=True, resume=False)
            launched = []

            def execute(command, **_kwargs):
                destination = Path(command[4])
                count = int(command[command.index("--agents") + 1])
                workload = command[command.index("--workload") + 1]
                seconds = int(command[command.index("--seconds") + 1])
                warmup = int(command[command.index("--warmup") + 1])
                value = trial(count, workload, warmup, seconds)
                value["binaries"]["corgi"]["sha256"] = digest
                destination.mkdir()
                agent_scale.save(destination / "comparison.json", value)
                launched.append((count, workload, seconds))
                return argparse.Namespace(returncode=0)

            topology = dict(selected=list(range(32, 40)), cpus="32-39")
            with patch.object(agent_scale.corgi_costs, "topology", return_value=topology), \
                    patch.object(agent_scale.subprocess, "check_output", return_value="commit\n"), \
                    patch.object(agent_scale.subprocess, "run", side_effect=execute), \
                    contextlib.redirect_stdout(io.StringIO()):
                agent_scale.run(args)
                self.assertEqual(launched, [(64, "idle", 3), (64, "busy", 3)])
                args.resume = True
                args.preflight_only = False
                agent_scale.run(args)
                self.assertEqual(launched[-2:], [(4, "idle", 60), (4, "busy", 60)])
                self.assertEqual(len(launched), 4)
                agent_scale.run(args)
                self.assertEqual(len(launched), 4)
                failed_path = args.output / "4-busy/comparison.json"
                value = agent_scale.read(failed_path)
                value["attempts"][0].update(accepted=False, strict_environment_pass=False)
                value["status"] = "incomplete due to sibling load"
                agent_scale.save(failed_path, value)
                original = failed_path.read_bytes()
                with self.assertRaisesRegex(ValueError, "Preserved incomplete case"):
                    agent_scale.run(args)
                self.assertEqual(len(launched), 4)
                self.assertEqual(failed_path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
