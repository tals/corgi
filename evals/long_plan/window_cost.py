#!/usr/bin/env python3
"""Price matching production-window replays, including every correction attempt."""

import json
import sys
from pathlib import Path

from pricing import CHECKED, RATES, SOURCE, price


def summarize(directory, reference):
    totals = dict.fromkeys(
        [
            "updates",
            "attempts",
            "uncached_input",
            "regular_input",
            "cache_write_input",
            "cached_input",
            "output",
            "thinking",
        ],
        0,
    )
    receipts = []
    cases = set()
    for path in sorted(Path(directory).glob("*.json")):
        data = json.loads(path.read_text())
        if "calls" not in data:
            continue
        assert data["complete"], f"Incomplete replay: {path}"
        assert data["model"].removeprefix("claude:") == "claude-haiku-5-5"
        case = data["case"]
        assert case not in cases, "Duplicate case"
        cases.add(case)
        baseline_path = Path(data["baseline"])
        source = json.loads(baseline_path.read_text())
        if "events" not in source["calls"][0]["input"]:
            # capture.ts saves a matched flat prompt alongside each plan window.
            assert [c["input"]["evidence"] for c in data["calls"]] == [
                c["input"]["evidence"] for c in source["calls"]
            ]
            source = json.loads(
                baseline_path.with_name(
                    baseline_path.name.removesuffix(".matched.json").removesuffix(
                        ".json"
                    )
                    + ".plan.json"
                ).read_text()
            )
        baseline = [(c["through"], c["input"]["events"]) for c in source["calls"]]
        if "events" in data["calls"][0]["input"]:
            assert [
                (c["through"], c["input"]["events"]) for c in data["calls"]
            ] == baseline, "Actual plan input differs from baseline evidence"
        assert reference.setdefault(case, baseline) == baseline, (
            "Changed evidence windows"
        )
        positions = [c["through"] for c in data["calls"]]
        assert reference.setdefault((case, "positions"), positions) == positions, (
            "Changed checkpoints"
        )
        for call in data["calls"]:
            totals["updates"] += 1
            attempts = call.get("attempts", [call])
            # Top-level usage is the sum of attempts for newer runners.
            for key in ["input", "cached_input", "output"]:
                assert sum(int(a["usage"][key]) for a in attempts) == int(
                    call["usage"][key]
                )
            for attempt in attempts:
                totals["attempts"] += 1
                audit = attempt["audit"]

                # Older audits called only regular input "uncached". Use the
                # final receipts consistently across report writer versions.
                def total(key):
                    return sum(int(r.get(key, 0)) for r in audit["receipts"])

                regular = total("input_tokens")
                writes = total("cache_creation_input_tokens")
                reads = total("cache_read_input_tokens")
                output = total("output_tokens")
                thinking = sum(
                    int(r["output_tokens_details"]["thinking_tokens"])
                    for r in audit["receipts"]
                )
                assert int(attempt["usage"]["input"]) == regular + writes + reads
                assert int(attempt["usage"]["cached_input"]) == reads
                assert int(attempt["usage"]["output"]) == output
                assert 0 <= thinking <= output
                totals["regular_input"] += regular
                totals["cached_input"] += reads
                totals["uncached_input"] += regular + writes
                totals["cache_write_input"] += writes
                totals["output"] += output
                totals["thinking"] += thinking
                receipts.extend(audit["receipts"])
    assert cases and reference.setdefault("cases", cases) == cases, "Changed corpus"
    return {"directory": str(directory), **totals, "cost": price(receipts)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: window_cost.py RUN_DIR [RUN_DIR ...]")
    reference = {}
    print(
        json.dumps(
            {
                "runs": [summarize(d, reference) for d in sys.argv[1:]],
                "pricing": {
                    "source": SOURCE,
                    "checked": CHECKED,
                    "usd_per_million": RATES,
                },
                "accounting": "API-equivalent costs from final receipts, including retries. Thinking is already in output. Cache writes are uncached input.",
            },
            indent=2,
        )
    )
