#!/usr/bin/env python3
"""Export auditable tables from summarize.py's retained trial records."""
import argparse
import csv
import json
import os
from pathlib import Path

from summarize import distribution


def number(value):
    return "—" if value is None else f"{value:.2f}"


def spread(value):
    if not value or not value["n"]:
        return "—"
    middle = number(value["median"])
    return middle if value["n"] == 1 else f"{middle} [{number(value['min'])}–{number(value['max'])}]"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("summary")
    parser.add_argument("output")
    args = parser.parse_args()
    summary = json.loads(Path(args.summary).read_text())
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    groups = sorted(summary["groups"], key=lambda g: tuple((0, "") if item is None else (1, item) for item in g["key"]))
    parts = [
        "# Detailed measurements\n",
        "[Short report](report.md) · [Reproduction playbook](README.md) · "
        "[Machine-readable summary](evidence/summary.json) · [Trial CSV](evidence/trials.csv)\n",
        "Values are seconds unless stated otherwise. Brackets show the observed "
        "minimum–maximum across trials; central values are medians. Failed attempts "
        "are counted separately and do not become zero-second successes. These "
        "small samples do not estimate population reliability or confidence intervals.\n",
    ]

    def table(title, headings, rows):
        parts.append(f"\n## {title}\n")
        parts.append("| " + " | ".join(headings) + " |")
        parts.append("| " + " | ".join(["---"] * len(headings)) + " |")
        parts.extend("| " + " | ".join(map(str, row)) + " |" for row in rows)
        parts.append("")

    rows = []
    for group in groups:
        key = group["key"]
        if key[2] != "startup":
            continue
        rows.append([key[0], key[3], "warm" if key[4] else "cold",
                     f"{group['usable_seconds']['n']}/{group['trials']}",
                     spread(group["remote_seconds"]), spread(group["usable_seconds"])])
    table("Connection init", ["Product", "RTT ms", "SSH master", "Usable / attempts", "Fresh screen", "Usable input"], rows)

    faults = {"tcp_reset", "blackhole3", "blackhole15", "downstream15", "isolated30"}
    table("Recovery after network restoration", ["Product", "Fault", "Measured fault window", "Usable / trials", "Fresh screen", "Usable input"], [
        [g["key"][0], g["key"][2], spread(g.get("actual_fault_seconds")), f"{g['usable_seconds']['n']}/{g['trials']}", spread(g["recovery_seconds"]), spread(g["usable_seconds"])]
        for g in groups if g["key"][2] in faults
    ])
    parts.append("`tcp_reset` starts after the kernel destroys the connection. Other "
                 "recovery clocks start after packet forwarding is restored; outage "
                 "duration is additional. The isolated-machine case includes navigating "
                 "back to atlas.\n")

    isolated = {}
    delayed = {}
    for trial in summary["trials"]:
        for row in trial["results"]:
            for other in row.get("isolation", []):
                isolated.setdefault((trial["product"], other["machine"]), []).append(other)
            if "during_receipts" in row:
                delayed.setdefault((trial["product"], row["case"]), []).append(row)
    table("Healthy machines during atlas isolation", ["Product", "Destination", "Fresh screen", "Usable input", "Follow-up echo"], [
        [product, machine, spread(distribution([r["switch_seconds"] for r in rows])),
         spread(distribution([r["usable_seconds"] for r in rows])),
         f"{sum(r['echo']['ok'] for r in rows)}/{len(rows)}"]
        for (product, machine), rows in sorted(isolated.items())
    ])
    table("Input submitted during outages", ["Product", "Fault", "~2 s input eventually received", "~8 s input eventually received", "~2 s delivery delay"], [
        [product, case,
         f"{sum(bool(r['during_receipts']) for r in rows)}/{len(rows)}",
         f"{sum(bool(r.get('late_receipts')) for r in rows)}/{sum(bool(r.get('late_input_at')) for r in rows)}",
         spread(distribution([e["at"] - r["during_input_at"] for r in rows for e in r["during_receipts"]]))]
        for (product, case), rows in sorted(delayed.items())
    ])
    parts.append("Receipts establish execution at the remote producer, independently "
                 "of visible echo. Zero receipt means the operation did not reach this "
                 "producer during the retained run; it is not proof of a general "
                 "exactly-once guarantee. `0/0` means no late probe was scheduled.\n")

    streams = [g for g in groups if g["key"][2] == "stream"]
    table("Bandwidth and screen freshness", ["Product / SSH compression", "Workload", "Cap / loss", "Frames/s", "Screen age p95", "Catch-up successes", "Catch-up after lifting cap", "Delivered kbit/s"], [
        [f"{g['key'][0]} / {g['key'][1]}", g["key"][3],
         (g["key"][4] or "unlimited") + (f" / {g['key'][5]}%" if g["key"][5] else ""),
         spread(g["frames_per_second"]), spread(g["held_age_p95"]),
         f"{g['catchup_seconds']['n']}/{g['trials']}", spread(g["catchup_seconds"]), spread(g["tx_kbit_s"])] for g in streams
    ])
    parts.append("The p95 is computed over wall time within each 30-second trial, "
                 "including frozen screens, then summarized across trials. Loss rows "
                 "also add 10 ms normal jitter per direction. The workload continues "
                 "unchanged after lifting the cap. Compression=yes is an exploratory "
                 "configuration diagnostic with one trial, separate from defaults.\n")
    table("Input under bandwidth pressure", ["Product / SSH compression", "Workload", "Cap / loss", "Visible within window", "Eventually received", "Visible echo latency"], [
        [f"{g['key'][0]} / {g['key'][1]}", g["key"][3],
         (g["key"][4] or "unlimited") + (f" / {g['key'][5]}%" if g["key"][5] else ""),
         f"{g['input_visible']}/{g['input_sent']}", f"{g['input_received']}/{g['input_sent']}",
         spread(g["input_latency"])] for g in streams
    ])
    parts.append("Latency describes visible successes only; the adjacent counts keep "
                 "missing acknowledgements visible. The first input is sent after "
                 "the counter snapshot, then approximately every six seconds.\n")

    table("Real elapsed-time client freezes", ["Product", "Freeze seconds", "Fresh screen after wake", "Usable input after wake", "Pending operation receipts", "Remote workloads continued", "Follow-up echo"], [
        [t["product"], r["sleep_seconds"], number(r["recovery_seconds"]), number(r["usable_seconds"]),
         r["pending_input_count"], r["continuity"]["same_remote_pids_throughout"] and r["continuity"]["all_remote_cpu_ticks_advanced"], r["echo"]["ok"]]
        for t in summary["trials"] for r in t["results"] if r["case"] == "sleep"
    ])
    duplicates = sum(len(t["duplicate_tokens"]) for t in summary["trials"])
    parts.append(f"Duplicate input tokens across these retained trials: **{duplicates}**. "
                 "Each sleep duration has one observation per product.\n")

    table("Raw evidence index", ["Trial", "Results", "Terminal and network records"], [
        [Path(t["path"]).name,
         f"[JSON]({os.path.relpath(Path(t['path']) / 'results.json', output)})",
         f"[Directory]({os.path.relpath(t['path'], output)}/)"] for t in summary["trials"]
    ])
    (output / "measurements.md").write_text("\n".join(parts).rstrip() + "\n")
    (output / "evidence").mkdir(exist_ok=True)
    columns = ["trial", "product", "compression", "case", "rtt_ms", "warm", "kind", "rate", "loss_percent", "sleep_seconds",
               "remote_seconds", "usable_seconds", "recovery_seconds", "catchup_seconds", "frames_per_second", "screen_age_p95",
               "input_visible", "input_received", "input_sent", "delivered_kbit_s", "failure"]
    with (output / "evidence/trials.csv").open("w") as file:
        writer = csv.DictWriter(file, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        for trial in summary["trials"]:
            for row in trial["results"]:
                value = {k: row.get(k) for k in columns}
                value.update(trial=Path(trial["path"]).name, product=trial["product"], compression=trial["manifest"]["args"]["ssh_compression"],
                             screen_age_p95=row.get("held_age", {}).get("p95"),
                             input_sent=len(row["probes"]) if "probes" in row else None,
                             delivered_kbit_s=row.get("network", {}).get("tx_kbit_s"))
                writer.writerow(value)


if __name__ == "__main__":
    main()
