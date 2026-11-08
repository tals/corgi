#!/usr/bin/env python3
"""Publish the shared measurement tables with all four transport-comparison arms."""

import argparse
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import adaptive_publish

PRODUCTS = [
    ("before", "WS uncompressed"),
    ("after", "WS zstd"),
    ("control", "WS native deflate"),
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
    text = text.replace("no pending write", "no pre-freeze input").replace(
        "+ pending write", "+ input before freeze"
    )
    # The shared publisher also knows scenarios outside this matrix; omit wholly unscheduled rows.
    text = (
        "\n".join(
            line for line in text.splitlines() if line.count("pending") != len(PRODUCTS)
        )
        + "\n"
    )
    tables.write_text(text)
    for name in [
        "audit.json",
        "audit-standard.json",
        "summary.json",
        "trials.json",
        "labels.json",
    ]:
        target = args.destination / "evidence"
        target.mkdir(exist_ok=True)
        shutil.copy2(args.reduction / name, target / name)
    rows = json.loads((args.reduction / "summary.json").read_text())
    measurements = args.destination / "measurements.md"
    measurements.write_text(
        measurements.read_text().replace(
            "`sleep` also has an unacknowledged input write",
            "`sleep` also sends input immediately before the freeze (TCP ACK state is not asserted)",
        )
    )
    measurements.write_text(
        "\n".join(
            (
                line.replace("| WS zstd |", "| WS zstd (raw accounting) |")
                if "accounting-" in line
                else line
            )
            for line in measurements.read_text().splitlines()
        )
        + "\n"
    )
    if not any(row["key"][2] == "navigation" for row in rows):
        text = measurements.read_text().replace(
            "Navigation pools nine unseen-tab clicks (three per lab), or three cached-tab returns. ",
            "",
        )
        measurements.write_text(text)

    indexed = {tuple(row["key"]): row for row in rows}

    def metric(label, key, field):
        return (
            indexed[(key[0], label, *key[1:])]["metrics"].get(field, {}).get("median")
        )

    header = [
        "| Scenario | WS plain | WS zstd | WS native deflate | Herdr + SSH-C |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    bandwidth = list(header)
    for suite, cap, rtt, caption in [
        ("stream-20", None, 20, "Uncapped, 20 ms RTT"),
        ("stream-120", "1mbit", 120, "1 Mbit/s, 120 ms RTT"),
        ("stream-120", "64kbit", 120, "64 kbit/s, 120 ms RTT"),
    ]:
        for kind in ["sparse", "dense"]:
            key = [suite, "stream", kind, cap, rtt, None, None]
            cells = [
                f"{metric(label, key, 'total_kbit_s'):,.0f} / {metric(label, key, 'fps'):.1f}"
                for label, _ in PRODUCTS
            ]
            bandwidth.append("| " + " | ".join([f"{caption}, {kind}", *cells]) + " |")
    behavior = list(header)
    for caption, key, field, precision in [
        (
            "First remote tab UI, cold / 120 ms RTT, s",
            ["cold-ui", "startup", 120, False],
            "ui_seconds",
            2,
        ),
        (
            "First pane content, same launch, s",
            ["cold-ui", "startup", 120, False],
            "first_content_seconds",
            2,
        ),
        (
            "Dense 60 Hz, 300 ms RTT / 1 Mbit/s, updates/s",
            ["cadence", "stream", "dense", "1mbit", 300, None, None],
            "fps",
            1,
        ),
        (
            "Dense 64 kbit/s / 120 ms RTT, P95 screen age, s",
            ["stream-120", "stream", "dense", "64kbit", 120, None, None],
            "p95_age",
            2,
        ),
        (
            "After 64 kbit/s → 1 Mbit/s, first fresh screen, s",
            ["transition", "transition", "dense", "1mbit", 120, None, "after-cap"],
            "catchup_seconds",
            2,
        ),
        (
            "After 3 s outage, usable, s",
            ["faults-sparse", "blackhole3"],
            "usable_seconds",
            2,
        ),
        (
            "After 35 s outage, usable, s",
            ["faults-sparse", "blackhole35"],
            "usable_seconds",
            2,
        ),
        (
            "After 180 s freeze, no pre-freeze input, usable, s",
            ["sleep-clean", "sleep"],
            "usable_seconds",
            2,
        ),
        (
            "After 180 s freeze, input before freeze, usable, s",
            ["sleep", "sleep"],
            "usable_seconds",
            2,
        ),
    ]:
        cells = []
        for label, _ in PRODUCTS:
            value = metric(label, key, field)
            cells.append(
                f"{value:.{precision}f}" if value is not None else "none within 10 s"
            )
        behavior.append("| " + " | ".join([caption, *cells]) + " |")
    cpu_data = json.loads((args.destination / "evidence/cpu.json").read_text())
    if cpu_data["problems"]:
        raise SystemExit("CPU reduction failed")
    cpu = {
        tuple(row["key"]): row["metrics"]["combined_cores"]["median"]
        for row in cpu_data["summary"]
    }
    sparse = ["stream-20", "stream", "sparse", None, 20, None, None]
    dense = ["stream-20", "stream", "dense", None, 20, None, None]
    premiums = [
        (
            metric("control", key, "total_kbit_s")
            / metric("after", key, "total_kbit_s")
            - 1
        )
        * 100
        for key in [sparse, dense]
    ]
    report = [
        "# Native WebSocket deflate: application comparison",
        "",
        f"**Native Bun deflate performs similarly to zstd in these application scenarios, but uses {premiums[0]:.0f}% more sparse traffic and {premiums[1]:.0f}% more dense traffic at equal 20 Hz output.** Its component CPU advantage becomes small at application level.",
        "",
        "Cells: **total kbit/s / visible updates/s**, with 20 Hz input. All WS arms retain SSH. Caps are per direction; totals include both directions and network overhead. Three-trial medians; [ranges and evidence](measurements.md#streaming).",
        "",
        *bandwidth,
        "",
        "“Usable” requires a fresh screen and input echo in the actual viewer. These outage rows use sparse output; [full results](measurements.md) include dense outages, navigation, loss and 600 ms RTT.",
        "",
        *behavior,
        "",
        f"Dense 20 Hz **application + SSH + bridge CPU** was **{cpu[('stream-20', 'after', 'dense')]:.3f} cores with zstd versus {cpu[('stream-20', 'control', 'dense')]:.3f} with native deflate**, with overlapping trial ranges. Herdr used {cpu[('stream-20', 'herdr', 'dense')]:.3f} cores. This includes Herdr’s SSH compression. [CPU breakdown and limits](measurement-checks.md#cpu-includes-the-compression-process).",
        "",
        "Most extra sparse traffic is upstream: Bun leaves small client messages uncompressed. Zstd with raw-byte controller accounting also delivered **59.1 updates/s**, so the small cadence gap is not a codec-speed result. [Measurement controls](measurement-checks.md).",
        "",
        "Two qualifications: [initial queue drain affects severe-link P95](backpressure.md), and [Herdr’s long freeze recovery depends on TCP state](../websocket_app/sleep-interpretation.md). Both remain in the reported results.",
        "",
        f"**Evidence:** [{audit['labs']}/{audit['expected_labs']} labs and {audit['checks_passed']:,} audit checks passed](evidence/audit.json); [143 codec/packet checks](evidence/proof.json). Packet sums matched bandwidth counters within 1.02%. Herdr is unpatched. WS+zstd is an application subprotocol; native deflate uses the standard extension with history.",
        "",
        "**Scope:** evaluation builds only; production source is unchanged. WS daemon handoff and oversized compressed-burst handling still need production work. [Reproduction playbook](README.md) · [Detailed tables](tables.md) · [Exact builds](evidence/builds.json).",
        "",
    ]
    (args.destination / "report.md").write_text("\n".join(report))


if __name__ == "__main__":
    main()
