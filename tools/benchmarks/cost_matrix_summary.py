#!/usr/bin/env python3
"""Summarize accepted Corgi/Herdr trials without treating different UI bytes as equivalence."""
import argparse
import json
from pathlib import Path
import statistics


def extent(values):
    return dict(mean=statistics.mean(values), minimum=min(values), maximum=max(values), trials=len(values)) if values else None


def summarize(path):
    source = json.loads(path.read_text())
    eligible_nodes = {pair['node'] for pair in source['pair_eligibility'] if pair['eligible']} if 'pair_eligibility' in source else None
    grouped = {}
    for attempt in source['attempts']:
        if not attempt['accepted'] or eligible_nodes is not None and attempt['node'] not in eligible_nodes:
            continue
        for row in attempt['results']:
            grouped.setdefault(row['name'], {}).setdefault(attempt['role'], []).append(row)
    phases = {}
    for name, roles in grouped.items():
        phase = {}
        for role, rows in roles.items():
            totals = [r['daemon_cpu'] + (r['viewer_cpu'] or 0) for r in rows]
            values = dict(total_cpu=extent(totals))
            for metric in ['daemon_cpu', 'daemon_child_cpu', 'viewer_cpu', 'viewer_bytes_per_second', 'daemon_rss_median_kib', 'viewer_rss_median_kib']:
                values[metric] = extent([r[metric] for r in rows if r.get(metric) is not None])
            for component in ['daemon', 'viewer']:
                memory = [r.get('memory_after', {}).get(component) for r in rows]
                memory = [m['kib'] for m in memory if m]
                for field in ['Rss', 'Pss', 'Pss_Anon', 'Pss_File', 'Private_Clean', 'Private_Dirty']:
                    values[f'{component}_postwindow_{field}_kib'] = extent([m[field] for m in memory if field in m])
            values['source_progress_hz'] = extent([r['streaming_progress']['visible_lines_per_second'] for r in rows if r.get('streaming_progress')])
            values['observed_pane_hz'] = extent([r['streaming_quality']['visible_changes_per_second'] for r in rows if r.get('streaming_quality')])
            if role == 'corgi':
                values['observed_ui_hz'] = extent([r['streaming_quality']['animation']['visible_changes_per_second'] for r in rows if r.get('streaming_quality')])
            phase[role] = values
        if all(role in phase for role in ['corgi', 'herdr']):
            phase['corgi_over_herdr_total_cpu'] = phase['corgi']['total_cpu']['mean'] / phase['herdr']['total_cpu']['mean']
            phase['corgi_over_herdr_viewer_cpu'] = phase['corgi']['viewer_cpu']['mean'] / phase['herdr']['viewer_cpu']['mean'] if phase['herdr']['viewer_cpu'] else None
        phases[name] = phase
    return dict(source=str(path.resolve()), status=source['status'], scenario=source.get('scenario', 'default'),
                measurement_protocol=source.get('measurement_protocol'), blocks=source.get('blocks', []),
                uclamp=source.get('uclamp'), causal_comparison_eligible=source.get('causal_comparison_eligible'),
                ineligible_pairs=[pair for pair in source.get('pair_eligibility', []) if not pair['eligible']],
                notes=['CPU percent of one core; daemon children field counts waited children, not the whole subtree.',
                       'PSS and private memory are one snapshot after CPU/cadence windows; RSS median uses periodic samples inside window.',
                       'Defaults retained. Corgi has animation/resources that Herdr does not duplicate; output-byte differences are reported, not treated as parity.',
                       'Single-node pairs are directional. AB/BA on both nodes is required for final performance claims.'],
                rejected=[dict(name=a['name'], exit_code=a['exit_code'], sibling_busy=a['max_sibling_busy']) for a in source['attempts'] if not a['accepted']], phases=phases)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('comparison', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = json.dumps(summarize(args.comparison), indent=2) + '\n'
    if args.output:
        args.output.write_text(result)
    else:
        print(result, end='')


if __name__ == '__main__':
    main()
