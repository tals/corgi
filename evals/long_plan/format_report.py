#!/usr/bin/env python3
"""Compare two saved replay prefixes, including rejected attempts and thinking."""

import json
import sys
from pathlib import Path

from pricing import CHECKED, RATES, SOURCE, price


def read(path):
    return json.loads(path.read_text())


def summarize(prefix, reference, reviewed=False):
    totals = dict.fromkeys(
        [
            "updates",
            "attempts",
            "rejected_attempts",
            "failed_updates",
            "checks",
            "passed",
            "semantic_checks",
            "semantic_passed",
            "input",
            "cached_input",
            "uncached_input",
            "regular_input",
            "cache_write_input",
            "output",
            "thinking",
            "extra_format_calls_lower_bound",
            "automatic_corrections",
            "preambles",
        ],
        0,
    )
    failures = []
    receipts = []
    for corpus, count in [("real", 4), ("synthetic", 16), ("focus", 1)]:
        directory = Path(f"{prefix}-{corpus}")
        report = read(directory / "report.json")
        assert report["model"] == "claude:claude-haiku-5-5", (
            "Pricing is specific to Haiku 5.5"
        )
        if reviewed:
            review = read(directory / "review.json")
            assert (
                reference.setdefault((corpus, "review"), review["manifest_hash"])
                == review["manifest_hash"]
            ), "Changed review rubric"
            report["cases"] = review["cases"]
        assert len(report["cases"]) == count, f"Incomplete corpus: {directory}"
        config = {
            k: report[k]
            for k in ["model", "effort", "batch", "ablation", "manifest_hash"]
        }
        assert reference.setdefault(corpus, config) == config, (
            "Changed replay configuration"
        )
        for case in report["cases"]:
            key = (corpus, case["id"])
            assert reference.setdefault(key, case["source_hash"]) == case["source_hash"]
            checks = case["checks"]
            assert reference.setdefault(
                (*key, "rubric"), [c["name"] for c in checks]
            ) == [c["name"] for c in checks]
            for check in checks:
                totals["checks"] += 1
                totals["passed"] += check["pass"]
                if check["name"] not in [
                    "complete replay",
                    "token conservation",
                    "parent completion agrees with children",
                ]:
                    totals["semantic_checks"] += 1
                    totals["semantic_passed"] += check["pass"]
                if not check["pass"]:
                    failures.append({"case": case["id"], "check": check["name"]})
            calls = read(directory / (case["id"] + ".calls.json"))
            positions = [c["through"] for c in calls]
            assert reference.setdefault((*key, "positions"), positions) == positions, (
                "Changed checkpoints"
            )
            for call in calls:
                evidence = call["input"]["events"]
                assert (
                    reference.setdefault((*key, call["through"]), evidence) == evidence
                ), "Changed evidence"
                totals["updates"] += 1
                totals["failed_updates"] += "error" in call
                totals["automatic_corrections"] += len(call.get("repairs", []))
                attempts = call["attempts"]
                totals["rejected_attempts"] += len(attempts) - 1 + ("error" in call)
                for attempt in attempts:
                    totals["attempts"] += 1
                    audit, usage = attempt["audit"], attempt["usage"]
                    receipts.extend(audit["receipts"])
                    assert audit["thinking"] is not None, "Unknown thinking subtotal"
                    assert int(usage["input"]) == sum(
                        int(audit[k])
                        for k in [
                            "regular_input",
                            "cache_write_input",
                            "cache_read_input",
                        ]
                    )
                    assert int(usage["cached_input"]) == int(audit["cache_read_input"])
                    assert int(usage["output"]) == int(audit["output"])
                    assert 0 <= int(audit["thinking"]) <= int(audit["output"])
                    for k in ["input", "cached_input", "output"]:
                        totals[k] += int(usage[k])
                    totals["uncached_input"] += int(audit["regular_input"]) + int(
                        audit["cache_write_input"]
                    )
                    totals["regular_input"] += int(audit["regular_input"])
                    totals["cache_write_input"] += int(audit["cache_write_input"])
                    totals["thinking"] += int(audit["thinking"])
                    totals["extra_format_calls_lower_bound"] += sum(
                        max(0, len(r.get("iterations", [])) - 1)
                        for r in audit["receipts"]
                    )
                    lines = attempt["raw"].strip().splitlines()
                    totals["preambles"] += (
                        "BEGIN_PLAN" in lines and lines.index("BEGIN_PLAN") > 0
                    )
    totals["nonthinking_output"] = totals["output"] - totals["thinking"]
    totals["total_tokens"] = totals["input"] + totals["output"]
    return {
        "prefix": str(prefix),
        **totals,
        "failures": failures,
        "cost": price(receipts),
    }


if __name__ == "__main__":
    reviewed = "--review" in sys.argv
    baseline, candidate, output = [arg for arg in sys.argv[1:] if arg != "--review"]
    reference = {}
    result = {
        "baseline": summarize(baseline, reference, reviewed),
        "candidate": summarize(candidate, reference, reviewed),
        "reviewed": reviewed,
        "pricing": {"source": SOURCE, "checked": CHECKED, "usd_per_million": RATES},
        "accounting": "Final receipts include all attempts. Thinking is already part of output. Uncached input includes cache writes.",
    }
    Path(output).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
