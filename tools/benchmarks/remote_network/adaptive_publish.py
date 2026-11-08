#!/usr/bin/env python3
"""Publish linked tables from the audited reduction, without hand-entered timings."""

import argparse
import json
import os
from pathlib import Path

PRODUCTS = [
    ("before", "Corgi before"),
    ("after", "Corgi now"),
    ("herdr", "Stock Herdr + SSH-C"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reduction")
    parser.add_argument("destination")
    parser.add_argument("--edge")
    args = parser.parse_args()
    source, out = Path(args.reduction), Path(args.destination)
    out.mkdir(parents=True, exist_ok=True)
    rows = json.loads((source / "summary.json").read_text())
    if args.edge:
        rows += [
            r
            for r in json.loads((Path(args.edge) / "summary.json").read_text())
            if r["key"][2] == "stream"
        ]
    indexed = {tuple(row["key"]): row for row in rows}

    def link(row):
        return ", ".join(
            f"[{i + 1}]({os.path.relpath(p, out)})"
            for i, p in enumerate(dict.fromkeys(row["evidence"]))
        )

    def value(row, metric, precision=2, spread=True):
        d = row["metrics"].get(metric, {})
        if d.get("median") is None:
            return "—"
        text = f'{d["median"]:.{precision}f}'
        if spread:
            text += f' [{d["min"]:.{precision}f}–{d["max"]:.{precision}f}]'
        if d["n"] != row["n"]:
            text += f' ({d["n"]}/{row["n"]})'
        return text

    lines = [
        "# Complete measurements",
        "",
        "Values are median [minimum–maximum] across three separate labs. These ranges are observed variation, not confidence intervals. Navigation pools nine unseen-tab clicks (three per lab), or three cached-tab returns. “—” means no qualifying observation; it is not zero. Every evidence link opens the original trial results.",
        "",
        "Source cadence is 20 Hz except the 60 Hz cadence suite. FPS counts complete, uniquely marked source updates visible in the viewer PTY, not application render calls. Display age is sampled every 50 ms of wall time, including stalls. Network traffic includes both directions and SSH/TCP overhead on the selected machine’s link; caps are per direction.",
        "",
    ]
    sections = [
        (
            "Startup",
            lambda k: k[0] in ("startup", "cold-ui"),
            [
                ("ui_seconds", "Tab UI, s", 2),
                ("first_content_seconds", "First content, s", 2),
                ("remote_seconds", "Fresh content, s", 2),
                ("usable_seconds", "Usable, s", 2),
            ],
        ),
        (
            "Tab changes",
            lambda k: k[2] == "navigation",
            [("first_content_seconds", "Content after click, s", 3)],
        ),
        (
            "Streaming",
            lambda k: k[2] == "stream",
            [
                ("fps", "Updates/s", 1),
                ("total_kbit_s", "Total kbit/s", 1),
                ("down_kbit_s", "Down kbit/s", 1),
                ("up_kbit_s", "Up kbit/s", 1),
                ("p95_age", "P95 age, s", 3),
                ("catchup_seconds", "Fresh after cap removal, s", 2),
                ("visible_inputs", "Visible inputs", 0),
                ("received_inputs", "Received inputs", 0),
                ("inputs", "Sent inputs", 0),
                ("product_cpu_cores", "Product CPU cores", 2),
                ("product_sum_rss_mib", "Sum RSS, MiB", 0),
            ],
        ),
        (
            "Continuous capacity changes",
            lambda k: k[2] == "transition",
            [
                ("fps", "Updates/s", 1),
                ("total_kbit_s", "Total kbit/s", 1),
                ("p95_age", "P95 age, s", 3),
                ("max_age", "Max age, s", 3),
                ("catchup_seconds", "First fresh state in phase, s", 2),
                ("visible_inputs", "Visible inputs", 0),
                ("received_inputs", "Received inputs", 0),
                ("inputs", "Sent inputs", 0),
            ],
        ),
        (
            "Recovery",
            lambda k: k[2] not in ("startup", "navigation", "stream", "transition"),
            [
                ("fresh_seconds", "Fresh content, s", 2),
                ("usable_seconds", "Usable, s", 2),
            ],
        ),
    ]
    for title, accepts, metrics in sections:
        lines += [
            f"## {title}",
            "",
            "| Scenario | Product | "
            + " | ".join(m[1] for m in metrics)
            + " | Evidence |",
            "| --- | --- | " + " | ".join("---:" for _ in metrics) + " | --- |",
        ]
        selected = [r for r in rows if accepts(r["key"])]
        for row in sorted(
            selected, key=lambda r: (str(r["key"][:1] + r["key"][2:]), r["key"][1])
        ):
            key = row["key"]
            scenario = " / ".join(str(v) for v in [key[0], *key[2:]] if v is not None)
            name = dict(PRODUCTS)[key[1]]
            lines.append(
                "| "
                + " | ".join(
                    [
                        scenario,
                        name,
                        *[
                            value(row, *[metric, precision])
                            for metric, _, precision in metrics
                        ],
                        link(row),
                    ]
                )
                + " |"
            )
        lines += [""]
    lines += [
        "## Interpretation",
        "",
        "- Startup times start at viewer process launch and include scripted selection of the remote workspace. Only `cold-ui` has neither prior remote layout nor SSH master. Startup `warm=True` reuses SSH; later startup cases can display saved layout before new remote content. `remote_seconds` requires current source data, whereas first content can include a valid cached image.",
        "- Unseen-tab timings begin at the click. Returning to a cached tab can show its previous content immediately; this is not a fresh network response.",
        "- Standard streaming omits four seconds of settling. The continuous capacity-change suite omits none: dense output continues through 1 Mbit/s → 64 kbit/s → 1 Mbit/s, for 10/20/10 seconds. A missing fresh-state time there means none within that phase.",
        "- Usable recovery requires both a fresh complete screen and an input echo. Fault timings begin when the network is restored. `tcp_reset` begins at the injected reset. `isolated30` includes switching back to the affected machine; the raw trial also records interaction with the healthy machines.",
        "- Both sleep cases freeze client processes for 180 seconds, drop packets, and remove server-side TCP state. `sleep` also has an unacknowledged input write; `sleep-clean` removes that write. This models a specific failure path, not physical laptop suspend; the kernel keeps running.",
        "- Product CPU and summed RSS cover the viewer and all three daemons, excluding workload producers, SSH and the observer. Summed RSS double-counts shared pages. They are comparative process measurements, not compressor-only cost or total machine cost.",
        "- Fewer bytes with fewer delivered updates is not automatically better encoding. Compare the 20 Hz cases where both deliver the full source cadence. Inputs can reach the remote process yet remain invisible behind stale output; both counts are retained.",
        "",
        "[Audit](evidence/audit.json) · [Machine-readable distributions](evidence/summary.json) · [Per-trial reduction](evidence/trials.json) · [Playbook](README.md)",
        "",
    ]
    (out / "measurements.md").write_text("\n".join(lines))

    def table(specs):
        result = [
            "| Scenario / metric | Corgi before | Corgi now | Herdr + SSH-C |",
            "| --- | ---: | ---: | ---: |",
        ]
        for caption, key, metric, precision in specs:
            cells = []
            for product, _ in PRODUCTS:
                row = indexed.get(tuple([key[0], product, *key[1:]]))
                cells.append(value(row, metric, precision, False) if row else "pending")
            result.append("| " + " | ".join([caption, *cells]) + " |")
        return "\n".join(result)

    startup = table(
        [
            (
                "First uncached tab UI, 120 ms RTT: seconds ↓",
                ["cold-ui", "startup", 120, False],
                "ui_seconds",
                2,
            ),
            (
                "First pane content, same launch: seconds ↓",
                ["cold-ui", "startup", 120, False],
                "first_content_seconds",
                2,
            ),
            (
                "Unseen tab, connected at 120 ms RTT: seconds ↓",
                ["navigation", "navigation", 120, "uncached"],
                "first_content_seconds",
                3,
            ),
        ]
    )
    streaming = table(
        [
            (
                "Sparse 20 Hz, 120 ms RTT: total kbit/s ↓",
                ["stream-120", "stream", "sparse", "1mbit", 120, None, None],
                "total_kbit_s",
                0,
            ),
            (
                "Dense 20 Hz, 120 ms RTT: total kbit/s ↓",
                ["stream-120", "stream", "dense", "1mbit", 120, None, None],
                "total_kbit_s",
                0,
            ),
            (
                "Dense 20 Hz, 600 ms RTT: updates/s ↑",
                ["stream-600", "stream", "dense", "1mbit", 600, None, None],
                "fps",
                1,
            ),
            (
                "Dense 60 Hz, 300 ms RTT: updates/s ↑",
                ["cadence", "stream", "dense", "1mbit", 300, None, None],
                "fps",
                1,
            ),
            (
                "Dense at 64 kbit/s, 120 ms RTT: P95 age, seconds ↓",
                ["stream-120", "stream", "dense", "64kbit", 120, None, None],
                "p95_age",
                2,
            ),
            (
                "Dense at 64 kbit/s, 600 ms RTT: P95 age, seconds ↓",
                ["stream-600-low", "stream", "dense", "64kbit", 600, None, None],
                "p95_age",
                2,
            ),
        ]
    )
    recovery = table(
        [
            (
                "64 kbit/s → 1 Mbit/s: fresh within 10 s, seconds ↓",
                ["transition", "transition", "dense", "1mbit", 120, None, "after-cap"],
                "catchup_seconds",
                2,
            ),
            (
                "3-second outage, sparse: usable seconds ↓",
                ["faults-sparse", "blackhole3"],
                "usable_seconds",
                2,
            ),
            (
                "35-second outage, sparse: usable seconds ↓",
                ["faults-sparse", "blackhole35"],
                "usable_seconds",
                2,
            ),
            (
                "3-minute freeze, no pending write: usable seconds ↓",
                ["sleep-clean", "sleep"],
                "usable_seconds",
                2,
            ),
            (
                "3-minute freeze + pending write: usable seconds ↓",
                ["sleep", "sleep"],
                "usable_seconds",
                2,
            ),
        ]
    )
    (out / "tables.md").write_text(
        "# Main comparison tables\n\n"
        + startup
        + "\n\n"
        + streaming
        + "\n\n"
        + recovery
        + "\n"
    )


if __name__ == "__main__":
    main()
