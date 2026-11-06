#!/usr/bin/env python3
"""Build the short before/after report from retained summaries."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("baseline")
parser.add_argument("candidate")
parser.add_argument("output")
args = parser.parse_args()
baseline = json.loads(Path(args.baseline).read_text())
candidate = json.loads(Path(args.candidate).read_text())


def group(data, product, *case):
    return next(g for g in data["groups"] if g["key"] == [product, "default", *case])


def metric(data, product, case, field):
    return group(data, product, *case)[field]["median"]


def value(data, product, case, field):
    return f"{metric(data, product, case, field):.2f} s"


rows = [
    ("256 kbit/s progress screen: p95 age", ("stream", "sparse", "256kbit", None), "held_age_p95"),
    ("64 kbit/s progress screen: p95 age", ("stream", "sparse", "64kbit", None), "held_age_p95"),
    ("256 kbit/s dense output: p95 age", ("stream", "dense", "256kbit", None), "held_age_p95"),
    ("1% loss + jitter: p95 screen age", ("stream", "sparse", None, 1), "held_age_p95"),
    ("Lift 64 kbit/s cap → fresh screen", ("stream", "sparse", "64kbit", None), "catchup_seconds"),
    ("3-second outage → usable input", ("blackhole3",), "usable_seconds"),
    ("15-second outage → usable input", ("blackhole15",), "usable_seconds"),
]
table = ["| Measurement | Corgi before | Corgi fixed | Herdr |", "| --- | ---: | ---: | ---: |"]
for name, case, field in rows:
    table.append(f"| {name} | {value(baseline, 'corgi', case, field)} | {value(candidate, 'corgi', case, field)} | {value(baseline, 'herdr', case, field)} |")
streams = [g for g in candidate["groups"] if g["key"][0] == "corgi" and g["key"][2] == "stream"]
visible = sum(g["input_visible"] for g in streams)
received = sum(g["input_received"] for g in streams)
sent = sum(g["input_sent"] for g in streams)
startup = group(candidate, "corgi", "startup", 300, False)
attach = [metric(candidate, "corgi", ("startup", 120, warm), "usable_seconds") for warm in [False, True]]
wakes = [metric(candidate, "corgi", ("sleep", seconds), "usable_seconds") for seconds in [180, 660]]
dense = metric(candidate, "corgi", ("stream", "dense", "1mbit", None), "frames_per_second")
traffic = metric(candidate, "corgi", ("stream", "sparse", None, None), "tx_kbit_s")
herdr_traffic = metric(baseline, "herdr", ("stream", "sparse", None, None), "tx_kbit_s")
long_before = metric(baseline, "corgi", ("blackhole15",), "usable_seconds")
long_after = metric(candidate, "corgi", ("blackhole15",), "usable_seconds")
regression = " The measured 15-second-outage median is also higher than before." if long_after > long_before * 1.2 else ""
report = f"""# Remote networking: gaps closed and remaining

**The cached-workspace crash is fixed, and constrained links now stay usable.**
Corgi displayed **{visible}/{sent}** bandwidth/loss input probes; independent remote
logs confirm **{received}/{sent}** executions, with no duplicate tokens.
[Receipts and trial data](evidence/summary.json).

{chr(10).join(table)}

Values are medians of three trials at 120 ms RTT; lower is better. Screen age
includes time spent showing a frozen frame. The Herdr column is the original
unmodified v0.9.5 reference, not the additional one-round control.
Real SSH and viewers connect a client and two remotes, with four panes per
machine; stream windows last 30 seconds at a nominal 20 Hz.
Numbers pin `691fc36b`; the later pane-exit fix (`59a7fa4c`) has separate
[regression validation](evidence/validation.json).
[Before/Herdr evidence](../measurements.md) · [Fixed Corgi and new control](measurements.md).

**Startup:** the previously failing cold attach at 300 ms RTT now succeeds
**{startup['usable_seconds']['n']}/{startup['trials']}** times. At 120 ms, cold/warm
attach to usable input takes **{attach[0]:.2f}/{attach[1]:.2f} s**.
[All attach attempts](measurements.md#connection-init).

**Client freezes:** recovery to usable input took **{wakes[0]:.2f}/{wakes[1]:.2f} s**
after 3/11 minutes. Both retained all eight remote workloads and executed the
pending input once. These are single trials using SIGSTOP plus lost TCP
connections; they do not measure physical laptop suspend.
[Continuity evidence](measurements.md#real-elapsed-time-client-freezes).

**Remaining gaps:** short-outage recovery still trails Herdr.{regression} Dense output at
1 Mbit/s delivers **{dense:.1f} updates/s**, versus Herdr's 20. Sparse unrestricted
traffic is **{traffic:.0f} kbit/s**, versus **{herdr_traffic:.0f} kbit/s**. The conservative
queue bound favors freshness over maximum throughput.
[Frame rates, traffic and ranges](measurements.md#bandwidth-and-screen-freshness).

The fixes send changed rows, acknowledge decoded frames, bound outstanding
render data, and enable SSH compression. Cached selections wait for the live
workspace; instant typing can seed from an idle screen when agent identity
arrives later. Older peers retain full-frame compatibility; Herdr is unpatched.
[Transport](../../../../src/viewer_stream.ts) · [Protocol notes](../../../../HACKING.md#change-protocols-or-saved-formats).

[Validation](evidence/validation.json) · [Evidence audit](evidence/audit.json) ·
[Reproduction playbook](README.md) · [Raw archive](../../../../dist/remote-network-followup-final.tar.gz)
"""
Path(args.output).write_text(report)
