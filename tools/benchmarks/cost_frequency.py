#!/usr/bin/env python3
"""Summarize observed frequency in each timed window; never normalize CPU by these readings."""
import argparse
from collections import defaultdict
from datetime import datetime
import json
from pathlib import Path
import statistics


def extent(values):
    return dict(mean=statistics.mean(values), median=statistics.median(values), minimum=min(values), maximum=max(values), samples=len(values)) if values else None


def summarize(directory):
    host = json.loads((directory / 'host.json').read_text())
    results = json.loads((directory / 'results.json').read_text())
    phases = []
    for row in results['results']:
        start = datetime.fromisoformat(row['started_at'].replace('Z', '+00:00')).timestamp()
        samples = [s for s in host['samples'] if start <= s['time'] <= start + row['seconds']]
        values = defaultdict(list)
        weighted_sum = weighted_ticks = 0
        for i, sample in enumerate(samples):
            for cpu, value in sample.get('frequency_khz', {}).items():
                if value is not None:
                    values[cpu].append(value)
                    if i and int(cpu) in host['selected']:
                        weight = sample.get('selected_busy', {}).get(cpu, 0) * (sample['time'] - samples[i - 1]['time'])
                        weighted_sum += weight * value
                        weighted_ticks += weight
        roles = {}
        for role in ['daemon', 'viewer']:
            pid = str(results.get(role, ''))
            total = stable = freq_total = 0
            for before, after in zip(samples, samples[1:]):
                a = before.get(role + '_threads', {}).get(pid)
                b = after.get(role + '_threads', {}).get(pid)
                if not a or not b:
                    continue
                delta = b['ticks'] - a['ticks']
                total += delta
                cpu = b.get('cpu')
                freq = after.get('frequency_khz', {}).get(str(cpu))
                if cpu is not None and a.get('cpu') == cpu and freq is not None:
                    stable += delta
                    freq_total += freq * delta
            roles[role] = dict(main_cpu_ticks=total, ticks_with_same_endpoint_cpu=stable,
                               same_endpoint_cpu_tick_fraction=stable / total if total else None,
                               main_tick_weighted_endpoint_frequency_khz=freq_total / stable if stable else None)
        phases.append(dict(name=row['name'], per_cpu_khz={cpu: extent(v) for cpu, v in values.items()},
                           selected_busy_weighted_observed_khz=weighted_sum / weighted_ticks if weighted_ticks else None,
                           **roles))
    return dict(directory=str(directory.resolve()),
                notes=['scaling_cur_freq is the reported cpufreq value, not effective execution cycles or a per-process frequency measurement.',
                       'Host busy weights include all tasks on selected cores. Main-thread tick weights use only intervals whose sampled endpoint CPU matches; migrations inside an interval remain invisible.',
                       'Report distributions and unmatched conditions; do not divide process CPU by these values to claim adjusted savings.'],
                process_count_before=host.get('population_before', {}).get('process_count'),
                process_count_after=host.get('population_after', {}).get('process_count'), phases=phases)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = json.dumps(summarize(args.directory), indent=2) + '\n'
    if args.output:
        args.output.write_text(result)
    else:
        print(result, end='')


if __name__ == '__main__':
    main()
