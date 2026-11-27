#!/usr/bin/env python3
"""Compare at least three complete matched replays per prompt, including retries."""

import json
import statistics
import sys
from pathlib import Path

import format_report
import window_cost
from pricing import CHECKED, RATES, SOURCE


def spread(values):
    return {
        "mean": statistics.mean(values),
        "min": min(values),
        "max": max(values),
        "sample_sd": statistics.stdev(values),
        "values": values,
    }


def case_scores(prefix):
    cases = {}
    structural = {
        "complete replay",
        "token conservation",
        "parent completion agrees with children",
    }
    for corpus in ["real", "synthetic", "focus"]:
        report = json.loads(Path(f"{prefix}-{corpus}/review.json").read_text())
        for case in report["cases"]:
            checks = [c for c in case["checks"] if c["name"] not in structural]
            cases[f"{corpus}/{case['id']}"] = {
                "passed": sum(c["pass"] for c in checks),
                "checks": len(checks),
                "failures": [c["name"] for c in checks if not c["pass"]],
            }
    return cases


def initial_cache(directory):
    rows = []
    for path in sorted(Path(directory).glob("*.plan.json")):
        data = json.loads(path.read_text())
        call = data["calls"][0]
        attempt = call.get("attempts", [call])[0]
        audit = attempt["audit"]
        rows.append(
            {
                "case": data["case"],
                "cached_input": int(audit["cache_read_input"]),
                "cache_write_input": int(audit["cache_write_input"]),
                "regular_input": int(audit["regular_input"]),
            }
        )
    return rows


def compare(groups):
    quality_reference, window_reference = {}, {}
    results = []
    for group in groups:
        assert len(group["quality"]) >= 3, "Need at least three independent quality replays"
        assert len(group["windows"]) >= 3, "Need at least three production-window replays"
        assert len({Path(p).resolve() for p in group["quality"]}) == len(group["quality"]), "Repeated quality directory"
        assert len({Path(p).resolve() for p in group["windows"]}) == len(group["windows"]), "Repeated window directory"
        quality = [
            format_report.summarize(Path(p), quality_reference, True)
            for p in group["quality"]
        ]
        assert all(q["updates"] == 99 and q["failed_updates"] == 0 for q in quality), (
            "Incomplete trial: retain it, but do not compare partial cost as a full run"
        )
        windows = [
            window_cost.summarize(Path(p), window_reference)
            for p in group["windows"]
        ]
        assert all(w["updates"] == 52 for w in windows)
        per_run = [case_scores(p) for p in group["quality"]]
        results.append(
            {
                "label": group["label"],
                "quality_runs": quality,
                "window_runs": windows,
                "quality": {
                    "passed": sum(q["semantic_passed"] for q in quality),
                    "checks": sum(q["semantic_checks"] for q in quality),
                    "spread": spread([q["semantic_passed"] for q in quality]),
                    "rejected_attempts": sum(q["rejected_attempts"] for q in quality),
                    "cost": spread([q["cost"]["usd"] for q in quality]),
                },
                "production": {
                    **{
                        key: spread([w[key] for w in windows])
                        for key in ["uncached_input", "cached_input", "output", "thinking"]
                    },
                    "cost": spread([w["cost"]["usd"] for w in windows]),
                    "initial_cache": [initial_cache(p) for p in group["windows"]],
                },
                "cases": {
                    case: {
                        "passed": sum(run[case]["passed"] for run in per_run),
                        "checks": sum(run[case]["checks"] for run in per_run),
                        "runs": [run[case] for run in per_run],
                    }
                    for case in per_run[0]
                },
            }
        )
    return {
        "groups": results,
        "pricing": {"source": SOURCE, "checked": CHECKED, "rates": RATES},
        "accounting": "Observed final receipts include every correction; thinking is already within output. Cache writes count as uncached input. Initial cache reuse is reported, not assumed equal.",
        "interpretation": "Independent repeats estimate variation on this fixed corpus; they do not establish reliability on unseen conversations. No failed or incomplete trial may be silently replaced by its successful rerun.",
    }


if __name__ == "__main__":
    config, output = map(Path, sys.argv[1:])
    output.write_text(json.dumps(compare(json.loads(config.read_text())), indent=2) + "\n")
