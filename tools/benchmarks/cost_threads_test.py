"""Fixed-input regression checks for additive CPU accounting; no live processes."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import cost_matrix
import cost_threads


def thread(name, user, system):
    return {"name": name, "ticks": user + system, "user_ticks": user, "system_ticks": system, "cpu": 0}


def samples():
    return [
        {"time": 0, "daemon_threads": {"1": thread("bun", 10, 5), "2": thread("Worker", 3, 1)}},
        {"time": 1, "daemon_threads": {"1": thread("bun", 13, 6), "2": thread("Worker", 4, 4),
                                      "3": thread("JITWorker", 2, 1)}},
        {"time": 2, "daemon_threads": {"1": thread("bun", 16, 7), "2": thread("Worker", 6, 5),
                                      "3": thread("JITWorker", 5, 2)}},
    ]


class Accounting(unittest.TestCase):
    def test_threads_read_user_and_system_from_the_same_stat(self):
        fields = ["0"] * 40
        fields[0], fields[11], fields[12], fields[36] = "R", "125", "75", "9"
        task = MagicMock()
        task.name = "17"
        task.__truediv__.return_value.read_text.return_value = "17 (name with ) bracket) " + " ".join(fields)
        with patch.object(cost_matrix, "Path") as path:
            path.return_value.iterdir.return_value = [task]
            self.assertEqual(cost_matrix.thread_ticks(42), {
                "17": {"name": "name with ) bracket", "ticks": 200, "cpu": 9,
                       "user_ticks": 125, "system_ticks": 75},
            })
        task.__truediv__.return_value.read_text.assert_called_once()

    def test_splits_sum_to_unchanged_totals_and_preserve_transient_accounting(self):
        result = cost_threads.window(samples(), 0, 2, "daemon", 1, 100)
        self.assertEqual(result["cpu_percent"], {"main": 4, "worker": 3.5})
        self.assertEqual(result["user_cpu_percent"], {"main": 3, "worker": 1.5})
        self.assertEqual(result["system_cpu_percent"], {"main": 1, "worker": 2})
        self.assertEqual(result["included_user_cpu_percent"] + result["included_system_cpu_percent"],
                         result["included_cpu_percent"])
        self.assertEqual(result["adjacent_sample_cpu_percent"], {"jit": 2, "main": 4, "worker": 3.5})
        for name, total in result["adjacent_sample_cpu_percent"].items():
            self.assertEqual(result["adjacent_sample_user_cpu_percent"][name] +
                             result["adjacent_sample_system_cpu_percent"][name], total)
        self.assertEqual(result["changed_threads"], ["3"])

    def test_legacy_and_mixed_records_never_fabricate_missing_splits(self):
        original = samples()
        legacy = copy.deepcopy(original)
        for sample in legacy:
            for value in sample["daemon_threads"].values():
                del value["user_ticks"], value["system_ticks"]
        old = cost_threads.window(legacy, 0, 2, "daemon", 1, 100)
        new = cost_threads.window(original, 0, 2, "daemon", 1, 100)
        self.assertEqual(old, {key: new[key] for key in old})
        self.assertNotIn("user_cpu_percent", old)
        self.assertNotIn("adjacent_sample_user_cpu_percent", old)
        del original[1]["daemon_threads"]["1"]["user_ticks"]
        mixed = cost_threads.window(original, 0, 2, "daemon", 1, 100)
        self.assertIn("user_cpu_percent", mixed)
        self.assertNotIn("adjacent_sample_user_cpu_percent", mixed)
        del original[-1]["daemon_threads"]["2"]["system_ticks"]
        mixed = cost_threads.window(original, 0, 2, "daemon", 1, 100)
        self.assertNotIn("user_cpu_percent", mixed)
        self.assertEqual(mixed["cpu_percent"], new["cpu_percent"])

    def test_process_phase_fields_remain_optional_for_old_results(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            host = {"samples": samples(), "max_sibling_busy": 0,
                    "cpu_accounting": "proc-stat-user-system-v1"}
            row = {"name": "streaming-agents-viewer", "started_at": "1970-01-01T00:00:00Z",
                   "seconds": 2, "daemon_cpu": 7.5, "daemon_user_cpu": 4.5, "daemon_system_cpu": 3}
            results = {"daemon": 1, "warmup": 0, "initialWarmup": 0, "results": [row]}
            (path / "host.json").write_text(json.dumps(host))
            (path / "results.json").write_text(json.dumps(results))
            new = cost_threads.summarize(path, 100)
            self.assertEqual(new["cpu_accounting"], "proc-stat-user-system-v1")
            process = new["phases"][0]["daemon"]
            self.assertEqual(process["process_user_cpu_percent"], 4.5)
            self.assertEqual(process["process_system_cpu_percent"], 3)
            del row["daemon_user_cpu"], row["daemon_system_cpu"], host["cpu_accounting"]
            (path / "host.json").write_text(json.dumps(host))
            (path / "results.json").write_text(json.dumps(results))
            old = cost_threads.summarize(path, 100)
            self.assertNotIn("cpu_accounting", old)
            self.assertNotIn("process_user_cpu_percent", old["phases"][0]["daemon"])
            self.assertEqual(old["phases"][0]["daemon"]["process_cpu_percent"], 7.5)


if __name__ == "__main__":
    unittest.main()
