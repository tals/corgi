#!/usr/bin/env python3
"""Audit matched throughput trials and retain per-trial results and distributions."""
import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
from summarize import summarize, held_age, distribution


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root')
    parser.add_argument('output')
    args = parser.parse_args()
    root, output = Path(args.root).resolve(), Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    plan = json.loads((root / 'plan.json').read_text())
    assert plan['suite'] == 'stream'
    labels = ['before', 'after', 'herdr']
    expected = []
    for spec in plan['stream_cases'].split(','):
        kind, rate, loss = ('sparse', None, 1) if spec == 'loss' else (*spec.split(':'), None)
        expected.append((kind, None if rate == 'unlimited' else rate, loss, plan['stream_rtt']))
    checks, problems, trials, groups = [], [], [], []
    hashes, binaries = collections.defaultdict(set), collections.defaultdict(set)

    def check(condition, message):
        (checks if condition else problems).append(message)

    for label in labels:
        paths = [root / f'{label}-{repeat + 1}' for repeat in range(plan['repeats'])]
        summary = summarize(paths, {})
        check(len(summary['trials']) == plan['repeats'], f'{label}: all trials present')
        for group in summary['groups']:
            group['label'] = label
            groups.append(group)
        for trial in summary['trials']:
            path = Path(trial['path'])
            name = path.name
            repeat = int(name.rsplit('-', 1)[1]) - 1
            manifest = trial['manifest']
            trial['label'] = label
            binaries[label].add(manifest['sha256'])
            check(manifest['args']['cpus'] == plan['cpu_sets'].split(';')[(labels.index(label) + repeat) % 3], f'{name}: planned CPU rotation')
            check(not manifest['args']['trace'] and not manifest['args']['capture'], f'{name}: diagnostics disabled')
            check(manifest['args']['ssh_compression'] == 'default', f'{name}: default SSH compression')
            check(manifest['topology'] == 'intermediate-bridge-tbf-netem-v2', f'{name}: shared topology')
            check(not trial['duplicate_tokens'], f'{name}: no duplicate input tokens')
            events = [json.loads(line) for line in (path / 'events.jsonl').read_text().splitlines()]
            check(events[-1]['event'] == 'cleanup_complete' and not events[-1]['namespaces_remaining'], f'{name}: namespace cleanup completed')
            check(not (path / 'failure.txt').exists(), f'{name}: no harness failure')
            saved = json.loads((path / 'harness.json').read_text())
            for filename in ['run.py', 'observe.ts', 'workload.py']:
                digest = hashlib.sha256((path / 'harness' / filename).read_bytes()).hexdigest()
                check(digest == saved[filename], f'{name}: saved {filename} matches manifest')
                hashes[filename].add(digest)
            for capture in path.glob('viewer-*.jsonl'):
                records = [json.loads(line) for line in capture.read_text().splitlines()]
                check(all(r['at'] >= r['source'] for r in records if r['event'] == 'frame'), f'{name}/{capture.name}: clocks consistent')
            raw = json.loads((path / 'results.json').read_text())
            check(collections.Counter(r['case'] for r in raw) == {'startup': 1, 'stream': len(expected)}, f'{name}: scheduled case counts')
            check(all(r.get('usable_seconds') is not None for r in raw if r['case'] == 'startup'), f'{name}: setup attach succeeded')
            actual = [(r['kind'], r['rate'], r.get('loss_percent'), r['rtt_ms']) for r in trial['results']]
            check(actual == expected, f'{name}: all scheduled profiles retained in order')
            for row in trial['results']:
                tag = f"{name}/{row['snapshot_prefix']}"
                shaping = next(e for e in reversed(events) if e['event'] == 'network' and e['machine'] == 'atlas' and e['at'] <= row['start'])
                capture = path / f"viewer-{row['snapshot_prefix'].removeprefix('stream-')}.jsonl"
                frames = [json.loads(line) for line in capture.read_text().splitlines()]
                frames = [f for f in frames if f['event'] == 'frame' and f['machine'] == 'atlas']
                initial = next((f for f in reversed(frames) if f['at'] < shaping['at']), None)
                transition = [f for f in frames if shaping['at'] <= f['at'] <= row['start']]
                row['cap_transition_age'] = distribution(held_age({'start': shaping['at'], 'end': row['start'], 'initial_frame': initial, 'frame_times': [f['at'] for f in transition], 'frame_sources': [f['source'] for f in transition]}))
                check(shaping['rate'] == row['rate'] and shaping['rtt'] == row['rtt_ms'], f'{tag}: cap transition profile')
                producers = row['producers']
                check(collections.Counter(p['machine'] for p in producers) == {'local': 4, 'atlas': 4, 'borealis': 4} and all(p['alive'] for p in producers), f'{tag}: twelve live producers')
                selected = [p for p in producers if p['source'] == 'atlas-source.json']
                check(len(selected) == 1 and (selected[0]['cols'], selected[0]['rows']) == (132, 47), f'{tag}: selected PTY dimensions')
                check(not row.get('failure') and row['catchup_seconds'] is not None, f'{tag}: recovered without failure')
                check(plan['stream_seconds'] <= row['end'] - row['start'] < plan['stream_seconds'] + .75, f'{tag}: sample duration')
                check(len(row['probes']) == 5 and row['input_received'] == 5, f'{tag}: all five inputs have independent receipts')
                check(all(len(trial['receipts'].get(p['token'], [])) == 1 for p in row['probes'] if p['ok']), f'{tag}: visible echoes each have one receipt')
                check(row['held_age']['n'] > 0 and row['frames'] > 0, f'{tag}: displayed-frame samples present')
            trials.append(trial)
    for filename, values in hashes.items():
        check(len(values) == 1, f'Identical {filename} across all products and rounds')
    for label, values in binaries.items():
        check(len(values) == 1, f'Identical {label} binary across rounds')
    for group in groups:
        rows = [r for trial in trials if trial['label'] == group['label'] for r in trial['results']
                if (r['kind'], r['rate'], r['loss_percent'], r['rtt_ms']) == tuple(group['key'][3:])]
        group['upstream_kbit_s'] = distribution([r['network']['rx_kbit_s'] for r in rows])
        group['total_kbit_s'] = distribution([sum(r['network'].values()) for r in rows])
        group['wire_bytes_per_update'] = distribution([sum(r['network'].values()) * 125 / r['frames_per_second'] for r in rows if r['frames_per_second']])
    audit = {'checks_passed': len(checks), 'problems': problems, 'checks': checks,
             'binary_hashes': {k: sorted(v) for k, v in binaries.items()},
             'harness_hashes': {k: sorted(v) for k, v in hashes.items()}}
    (output / 'audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    (output / 'summary.json').write_text(json.dumps({'plan': plan, 'groups': groups, 'trials': trials}, indent=2) + '\n')
    with (output / 'trials.csv').open('w') as file:
        writer = csv.writer(file, lineterminator='\n')
        writer.writerow(['label', 'trial', 'kind', 'rate', 'rtt_ms', 'loss_percent', 'updates_s', 'held_age_p95_s', 'catchup_s', 'input_visible', 'input_received', 'input_latency_p95_s', 'downstream_kbit_s', 'upstream_kbit_s', 'total_kbit_s', 'wire_bytes_per_update', 'cap_transition_age_max_s', 'evidence'])
        for trial in trials:
            for row in trial['results']:
                total = sum(row['network'].values())
                writer.writerow([trial['label'], Path(trial['path']).name, row['kind'], row['rate'], row['rtt_ms'], row['loss_percent'], row['frames_per_second'], row['held_age']['p95'], row['catchup_seconds'], row['input_visible'], row['input_received'], row['input_latency']['p95'], row['network']['tx_kbit_s'], row['network']['rx_kbit_s'], total, total * 125 / row['frames_per_second'] if row['frames_per_second'] else None, row['cap_transition_age']['max'], row['evidence']])
    print(json.dumps({'checks_passed': len(checks), 'problems': problems}))
    return int(bool(problems))


if __name__ == '__main__':
    raise SystemExit(main())
