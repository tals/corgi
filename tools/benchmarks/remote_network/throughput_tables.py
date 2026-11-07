#!/usr/bin/env python3
"""Render the audited throughput evidence, retaining trial ranges and missing inputs."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('report')
args = parser.parse_args()
root = Path(args.report)
labels = ['before', 'after', 'herdr']
lines = ['# Throughput and backpressure measurements', '',
         'Median [min–max] across three independent trials unless stated otherwise. Each producer emits 20 updates/s; delivered updates cannot exceed that ceiling. Before and after use the same native library; Herdr is the unchanged v0.9.5 release.', '']


def show(d):
    return f"{d['median']:.3f} [{d['min']:.3f}–{d['max']:.3f}]" if d and d['n'] else 'missing'


for rtt in [20, 120, 300]:
    suite = f'stream-{rtt}'
    data = json.loads((root / suite / 'evidence/summary.json').read_text())
    groups = data['groups']
    cases = list(dict.fromkeys(tuple(g['key'][3:]) for g in groups))
    lines += [f'## {rtt} ms RTT', '', f'[Individual trials]({suite}/evidence/trials.csv) · [Full distributions]({suite}/evidence/summary.json) · [Audit]({suite}/evidence/audit.json)', '']
    for title, field in [('Delivered updates/s', 'frames_per_second'), ('Displayed-screen age, wall-time p95 (seconds)', 'held_age_p95'), ('Catch-up after cap removal (seconds)', 'catchup_seconds'), ('Downstream traffic (kbit/s)', 'tx_kbit_s')]:
        lines += [f'### {title}', '', '| Output / cap | Corgi before | Corgi after | Herdr |', '| --- | ---: | ---: | ---: |']
        for case in cases:
            kind, rate, loss, _ = case
            name = f'{kind} / {rate or "unlimited"}' + (' / 1% loss + 10 ms jitter' if loss else '')
            cells = [show(next(g for g in groups if g['label'] == label and tuple(g['key'][3:]) == case)[field]) for label in labels]
            lines.append(f'| {name} | ' + ' | '.join(cells) + ' |')
        lines += ['']
    lines += ['### Input echoes visible within the measurement window', '', 'Visible / independently received. Each cell has 15 sent probes. Missing visible echoes remain missing; they are not treated as fast inputs.', '', '| Output / cap | Corgi before | Corgi after | Herdr |', '| --- | ---: | ---: | ---: |']
    for case in cases:
        name = f'{case[0]} / {case[1] or "unlimited"}' + (' / loss' if case[2] else '')
        cells = []
        for label in labels:
            g = next(g for g in groups if g['label'] == label and tuple(g['key'][3:]) == case)
            cells.append(f"{g['input_visible']} / {g['input_received']}")
        lines.append(f'| {name} | ' + ' | '.join(cells) + ' |')
    lines += ['']
lines += ['## Outage recovery', '', 'Time from restoration to unique remote input echo, with 120 ms RTT. Actual loss duration, fresh-screen timing, independent input receipts and producer continuity are retained per trial.', '', '[Sparse output: all six outage lengths and ranges](faults-sparse/measurements.md) · [Dense output: all six outage lengths and ranges](faults-dense/measurements.md)', '',
          '## Interpretation limits', '',
          'The cap-transition maximum over the first four seconds is also retained in each trial CSV. Steady-state lag uses the following 30 seconds. Cap removal keeps the configured RTT. An unlimited profile still has that RTT; it is not a zero-latency control. Streams are established at 120 ms before changing to the requested RTT. Thus the 300 ms result is a 120→300 ms path change: the candidate retains the faster learned baseline and falls back to 16 KiB. It is not a cold stream established at 300 ms.', '',
          'Input latency distributions exclude unobserved echoes and therefore must be read alongside the visibility counts. Herdr can display more sparse updates while showing substantially older content. Higher update count alone does not imply a more responsive screen.', '',
          'The same host runs isolated labs on disjoint CPUs. Repeats rotate CPUs within each suite. Three trials characterize these fixed scenarios; they are not a statistical equivalence test or a distribution of Internet conditions. See the [playbook](README.md) for exact scheduling and [raw archives](evidence/artifacts.json) for all observations.', '']
(root / 'measurements.md').write_text('\n'.join(lines))
