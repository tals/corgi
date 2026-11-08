#!/usr/bin/env python3
"""Publish the shared measurement tables with all four transport-comparison arms."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import adaptive_publish

PRODUCTS = [
    ("before", "Corgi direct"),
    ("after", "Corgi WebSocket"),
    ("control", "Corgi raw-adapter"),
    ("herdr", "Stock Herdr + SSH-C"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reduction", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    audit = json.loads((args.reduction / "audit.json").read_text())
    if audit["partial"] or audit["problems"] or audit["labs"] != audit["expected_labs"]:
        raise SystemExit("Publishing requires a complete, passing four-arm audit")
    adaptive_publish.PRODUCTS = PRODUCTS
    adaptive_publish.main()
    tables = args.destination / "tables.md"
    text = tables.read_text()
    text = text.replace(
        "| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |",
        "| Scenario / metric | " + " | ".join(name for _, name in PRODUCTS) + " |",
    ).replace("| --- | ---: | ---: | ---: |", "| --- | ---: | ---: | ---: | ---: |")
    # The shared publisher also knows scenarios outside this matrix; omit wholly unscheduled rows.
    text = (
        "\n".join(
            line for line in text.splitlines() if line.count("pending") != len(PRODUCTS)
        )
        + "\n"
    )
    tables.write_text(text)
    rows = json.loads((args.reduction / "summary.json").read_text())
    measurements = args.destination / "measurements.md"
    if not any(row["key"][2] == "navigation" for row in rows):
        text = measurements.read_text().replace(
            "Navigation pools nine unseen-tab clicks (three per lab), or three cached-tab returns. ",
            "",
        )
        measurements.write_text(text)


if __name__ == "__main__":
    main()
