"""Summarize complete balanced blocks; samples within a run are not replicates."""
import math
import statistics


def summary(attempts, node, order, calibration):
    chosen = [attempt for attempt in attempts if attempt['node'] == node and attempt['accepted']]
    phases = {}
    for attempt in chosen:
        for row in attempt['results']:
            phase = phases.setdefault(row['name'], {})
            role = phase.setdefault(attempt['role'], {'daemon': [], 'viewer': [], 'total': []})
            role['daemon'].append(row['daemon_cpu'])
            role['viewer'].append(row['viewer_cpu'] or 0)
            role['total'].append(row['daemon_cpu'] + (row['viewer_cpu'] or 0))
    result = {}
    for name, phase in phases.items():
        metrics = {}
        for metric in ('daemon', 'viewer', 'total'):
            a, b = phase.get('corgi', {}).get(metric, []), phase.get('herdr', {}).get(metric, [])
            if len(a) != 2 or len(b) != 2:
                raise ValueError('A balanced block needs exactly two accepted fresh trials per product')
            ca, hb = statistics.mean(a), statistics.mean(b)
            metrics[metric] = dict(corgi_values=a, herdr_values=b, corgi_mean=ca, herdr_mean=hb,
                                   corgi_range=[min(a), max(a)], herdr_range=[min(b), max(b)],
                                   absolute_cpu_percentage_point_gap=ca - hb,
                                   ratio=ca / hb if hb else None,
                                   log_ratio=math.log(ca / hb) if ca and hb else None)
        result[name] = metrics
    return dict(node=node, order=order, attempts=[attempt['name'] for attempt in chosen], phases=result,
                calibration=calibration, frequency_treatment='diagnostic only',
                note='One block is one independent contrast. Report ranges; confidence intervals require repeated independent blocks.')
