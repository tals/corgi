#!/usr/bin/env python3
"""Plot audited effort replays. Run with: uv run --with matplotlib python FILE RESULTS_DIR."""

import csv
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

root = Path(sys.argv[1])
repetitions = int(sys.argv[2]) if len(sys.argv) > 2 else 2
modes = ["high", "medium", "low", "brief"]
labels = ["High", "Medium", "Low\n(current)", "Low + brief\n(prompt trial)"]
corpora = ["real", "synthetic", "focus"]
expected_cases = {"real": 4, "synthetic": 16, "focus": 1}
kind_group = {
    "same_goal": "Hierarchy / intent",
    "same_episode": "Hierarchy / intent",
    "different_episode": "Hierarchy / intent",
    "planned_only": "Hierarchy / intent",
    "planned_step": "Hierarchy / intent",
    "focus": "Foreground focus",
    "bump": "Setbacks / recovery",
    "bump_count": "Setbacks / recovery",
    "no_bump_started": "Setbacks / recovery",
    "state": "Setbacks / recovery",
    "topic": "Titles / constraints",
    "subtitle": "Titles / constraints",
}
rubrics = {}
for corpus in corpora:
    manifest = (
        root / f"{corpus}.json"
        if corpus != "focus"
        else Path("evals/long_plan/focus_probe.json")
    )
    for case in json.loads(manifest.read_text()):
        rubrics[case["id"]] = {c["name"]: kind_group[c["kind"]] for c in case["checks"]}
rows = []
failures = []
source_hashes = {}
contracts = {}
checkpoints = {}
for mode in modes:
    for repeat in range(1, repetitions + 1):
        row = {
            "mode": mode,
            "repeat": repeat,
            "updates": 0,
            "attempts": 0,
            "invalid_attempts": 0,
            "failed_updates": 0,
            "automatic_corrections": 0,
            "corrected_updates": 0,
            "input": 0,
            "cached_input": 0,
            "output": 0,
            "thinking": 0,
            "cache_write_input": 0,
            "regular_input": 0,
            "checks": 0,
            "passed": 0,
            "semantic_checks": 0,
            "semantic_passed": 0,
            "structural_checks": 0,
            "structural_passed": 0,
            "elapsed_ms": 0,
            "extra_format_calls": 0,
            "groups": {},
            "cohorts": {},
        }
        for corpus in corpora:
            directory = root / f"{mode}-{repeat}-{corpus}"
            report = json.loads((directory / "report.json").read_text())
            if len(report["cases"]) != expected_cases[corpus]:
                raise ValueError(f"Incomplete report: {directory}")
            contract = [
                report[k]
                for k in [
                    "model",
                    "schema",
                    "batch",
                    "ablation",
                    "manifest_hash",
                    "timeout_ms",
                ]
            ]
            assert contracts.setdefault(corpus, contract) == contract, (
                "Changed replay configuration"
            )
            prompt_key = (corpus, mode == "brief")
            assert (
                contracts.setdefault(prompt_key, report["instructions"])
                == report["instructions"]
            ), "Changed prompt"
            expected_effort = "low" if mode == "brief" else mode
            assert report["effort"] == expected_effort
            assert report["brief_thinking"] == (mode == "brief")
            assert report["launches"] and all(
                l["effort"] == expected_effort for l in report["launches"]
            )
            row["cohorts"][corpus] = {"passed": 0, "checks": 0}
            for case in report["cases"]:
                old = source_hashes.setdefault(case["id"], case["source_hash"])
                assert old == case["source_hash"], "Changed source"
                for check in case["checks"]:
                    row["checks"] += 1
                    row["passed"] += int(check["pass"])
                    row["cohorts"][corpus]["checks"] += 1
                    row["cohorts"][corpus]["passed"] += int(check["pass"])
                    group = rubrics[case["id"]].get(check["name"])
                    category = "semantic" if group else "structural"
                    row[category + "_checks"] += 1
                    row[category + "_passed"] += int(check["pass"])
                    if group:
                        totals = row["groups"].setdefault(
                            group, {"passed": 0, "checks": 0}
                        )
                        totals["checks"] += 1
                        totals["passed"] += int(check["pass"])
                    if not check["pass"]:
                        failures.append(
                            {
                                "mode": mode,
                                "repeat": repeat,
                                "corpus": corpus,
                                "case": case["id"],
                                "check": check["name"],
                                "detail": check["detail"],
                            }
                        )
                calls = json.loads(
                    (directory / (case["id"] + ".calls.json")).read_text()
                )
                positions = [c["through"] for c in calls]
                previous = checkpoints.setdefault(case["id"], positions)
                if not any("error" in c for c in calls):
                    assert positions == previous, "Changed checkpoints"
                for call in calls:
                    row["automatic_corrections"] += len(call.get("repairs", []))
                    row["corrected_updates"] += int(bool(call.get("repairs", [])))
                    row["updates"] += 1
                    row["elapsed_ms"] += call["elapsed_ms"]
                    row["failed_updates"] += int("error" in call)
                    attempts = call["attempts"]
                    row["invalid_attempts"] += max(0, len(attempts) - 1) + int(
                        "error" in call
                    )
                    for attempt in attempts:
                        row["attempts"] += 1
                        usage, audit = attempt["usage"], attempt["audit"]
                        for key in ["input", "cached_input", "output"]:
                            row[key] += int(usage[key])
                        assert audit["thinking"] is not None, (
                            "Unknown thinking subtotal"
                        )
                        row["thinking"] += int(audit["thinking"])
                        row["regular_input"] += int(audit["regular_input"])
                        row["cache_write_input"] += int(audit["cache_write_input"])
                        assert int(usage["input"]) == sum(
                            int(audit[k])
                            for k in [
                                "regular_input",
                                "cache_write_input",
                                "cache_read_input",
                            ]
                        )
                        assert int(usage["output"]) == int(audit["output"])
                        for receipt in audit["receipts"]:
                            # These are a breakdown of the final receipt, never added to usage again.
                            iterations = receipt.get("iterations", [])
                            row["extra_format_calls"] += max(0, len(iterations) - 1)
        row["uncached_input"] = row["input"] - row["cached_input"]
        row["visible_output"] = row["output"] - row["thinking"]
        row["total"] = row["input"] + row["output"]
        row["quality_pct"] = 100 * row["passed"] / row["checks"]
        row["semantic_pct"] = 100 * row["semantic_passed"] / row["semantic_checks"]
        assert row["checks"] == 115 and row["semantic_checks"] == 52
        rows.append(row)

summary = {
    "model": "claude-haiku-5-5",
    "repetitions": repetitions,
    "expected_updates_per_replay": 99,
    "cases": "4 real conversations + 16 synthetic cases + 1 focus holdout",
    "method": "Same frozen transcripts, checkpoints, compact protocol, cache policy and rubric. Effort is overridden only in eval processes. Brief adds a prompt instruction. Each run starts independent conversations. Up to four concurrent workers, reversed submission order in repeat 2; the initial high/low pair started before medium/brief. Latency is not compared. Error bars span the recorded runs, not confidence intervals. Quality is measured on the accepted state after validation: 52 semantic checks plus 63 structural checks per replay. Automatic corrections are recorded separately. Input includes cache reads and writes; thinking is already in output. All recorded attempts and final provider receipts are counted.",
    "source_hashes": source_hashes,
    "runs": rows,
}
(root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
(root / "failures.json").write_text(json.dumps(failures, indent=2) + "\n")
columns = [k for k in rows[0] if k not in ["groups", "cohorts"]]
with (root / "summary.csv").open("w") as f:
    writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)

plt.rcParams.update(
    {
        "font.size": 10,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.titleweight": "bold",
        "figure.facecolor": "#f7f9fc",
        "axes.facecolor": "#f7f9fc",
    }
)
fig, axes = plt.subplots(
    2, 2, figsize=(14, 9), gridspec_kw={"height_ratios": [1, 1.08]}
)
fig.subplots_adjust(top=0.83, bottom=0.13, hspace=0.52, wspace=0.36)
fig.suptitle(
    "Haiku thinking: token usage and plan quality",
    x=0.075,
    ha="left",
    fontsize=20,
    weight="bold",
    y=0.98,
)
fig.text(
    0.075,
    0.925,
    f"21 cases · 99 planned checkpoints per replay · {repetitions} independent runs per setting\nSame model, evidence, cache policy and rubric; “brief” changes only the thinking guidance.",
    fontsize=11,
    va="top",
    color="#526177",
)
x = np.arange(len(modes))


def values(key):
    return np.array([[r[key] for r in rows if r["mode"] == mode] for mode in modes])


def mean(key):
    return values(key).mean(axis=1)


def range_bars(ax, key, scale=1):
    v = values(key) / scale
    m = v.mean(axis=1)
    ax.errorbar(
        x,
        m,
        yerr=[m - v.min(axis=1), v.max(axis=1) - m],
        fmt="none",
        ecolor="#25324a",
        capsize=4,
        lw=1.4,
    )


def ticks(ax):
    ax.set_xticks(x, labels)
    ax.grid(axis="y", alpha=0.15)
    ax.set_axisbelow(True)


ax = axes[0, 0]
ax.bar(x, mean("visible_output") / 1000, color="#4285b4", label="Response / formatting")
ax.bar(
    x,
    mean("thinking") / 1000,
    bottom=mean("visible_output") / 1000,
    color="#a48cce",
    label="Thinking (included in output)",
)
range_bars(ax, "output", 1000)
for i, n in enumerate(mean("output")):
    ax.annotate(
        f"{n / 1000:.1f}k",
        (i, values("output")[i].max() / 1000),
        xytext=(0, 10),
        textcoords="offset points",
        ha="center",
        weight="bold",
    )
ax.set_ylim(0, values("output").max() / 1000 * 1.28)
ax.set_title("Generated tokens per replay", loc="left")
ax.set_ylabel("Thousands of output tokens")
ax.legend(frameon=False, fontsize=9, loc="upper right")
ticks(ax)

ax = axes[0, 1]
ax.bar(
    x,
    mean("uncached_input") / 1000,
    color="#348c78",
    label="Uncached input (includes writes)",
)
ax.bar(
    x,
    mean("cached_input") / 1000,
    bottom=mean("uncached_input") / 1000,
    color="#bcd8ce",
    label="Cache reads",
)
range_bars(ax, "input", 1000)
for i, n in enumerate(mean("uncached_input")):
    ax.text(
        i,
        n / 2000,
        f"{n / 1000:.0f}k",
        ha="center",
        va="center",
        color="white",
        fontsize=9,
        weight="bold",
    )
ax.set_title("Input tokens per replay", loc="left")
ax.set_ylabel("Thousands of input tokens")
ax.legend(frameon=False, fontsize=9, loc="upper left")
ax.set_ylim(0, values("input").max() / 1000 * 1.25)
ticks(ax)

ax = axes[1, 0]
width = 0.28
for shift, key, color, label in [
    (-0.22, "semantic_pct", "#4285b4", "Semantic quality (52 checks)"),
    (0.22, "quality_pct", "#92a5b7", "All checks (115)"),
]:
    v = values(key)
    m = v.mean(axis=1)
    ax.bar(x + shift, m, width, color=color, label=label)
    ax.errorbar(
        x + shift,
        m,
        yerr=[m - v.min(axis=1), v.max(axis=1) - m],
        fmt="none",
        ecolor="#25324a",
        capsize=3,
    )
    for i, n in enumerate(m):
        ax.text(i + shift, v[i].max() + 2, f"{n:.1f}", ha="center", fontsize=9)
ax.set_ylim(0, 113)
ax.set_ylabel("Checks passed (%)")
ax.set_title("Quality checks passed", loc="left")
ax.legend(frameon=False, fontsize=9, loc="lower left")
ticks(ax)

ax = axes[1, 1]
groups = [
    "Hierarchy / intent",
    "Foreground focus",
    "Setbacks / recovery",
    "Titles / constraints",
]
matrix = []
for group in groups:
    cells = []
    for mode in modes:
        subset = [r["groups"][group] for r in rows if r["mode"] == mode]
        cells.append(
            (sum(v["passed"] for v in subset), sum(v["checks"] for v in subset))
        )
    matrix.append(cells)
pct = np.array([[100 * p / n for p, n in line] for line in matrix])
ax.imshow(pct, cmap="Blues", vmin=0, vmax=100, aspect="auto")
for i, line in enumerate(matrix):
    for j, (p, n) in enumerate(line):
        ax.text(
            j,
            i,
            f"{p}/{n}\n{100 * p / n:.0f}%",
            ha="center",
            va="center",
            color="white" if pct[i, j] > 60 else "#25324a",
            fontsize=10,
        )
ax.set_yticks(range(4), groups)
ax.set_xticks(x, labels)
ax.set_title("Where quality changes", loc="left", pad=12)
ax.tick_params(length=0)
for spine in ax.spines.values():
    spine.set_visible(False)

invalid = [
    int(sum(r["invalid_attempts"] for r in rows if r["mode"] == m)) for m in modes
]
fig.text(
    0.075,
    0.065,
    "Rejected patches / failed calls across all runs: "
    + " · ".join(
        f"{m}: {n}" for m, n in zip(["high", "medium", "low", "low + brief"], invalid)
    )
    + "\nAutomatic corrections per replay: "
    + " · ".join(
        f"{m}: {n:.1f}"
        for m, n in zip(
            ["high", "medium", "low", "low + brief"], mean("automatic_corrections")
        )
    )
    + "\nBars are per-replay means; whiskers span the observed runs. This is a small fixed regression set, not a statistical quality guarantee.",
    fontsize=9,
    va="top",
    color="#526177",
)
for extension in ["png", "svg", "pdf"]:
    fig.savefig(
        root / f"thinking-quality.{extension}", dpi=180, facecolor=fig.get_facecolor()
    )
print(
    json.dumps(
        [
            {
                "mode": m,
                "uncached": round(mean("uncached_input")[i]),
                "cached": round(mean("cached_input")[i]),
                "output": round(mean("output")[i]),
                "thinking": round(mean("thinking")[i]),
                "semantic_pct": round(mean("semantic_pct")[i], 2),
                "quality_pct": round(mean("quality_pct")[i], 2),
            }
            for i, m in enumerate(modes)
        ],
        indent=2,
    )
)
