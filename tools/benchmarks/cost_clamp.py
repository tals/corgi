"""Observe per-task utilization clamps without changing scheduler state."""
import os
from pathlib import Path
import time


FIELDS = ('uclamp.min', 'uclamp.max', 'effective uclamp.min', 'effective uclamp.max')


def task(tid):
    values = {}
    for line in Path(f'/proc/{tid}/sched').read_text().splitlines():
        if ':' not in line:
            continue
        key, value = line.split(':', 1)
        if key.strip() in FIELDS:
            values[key.strip()] = int(value.strip())
    if len(values) != len(FIELDS):
        raise RuntimeError(f'Missing utilization clamp fields for task {tid}')
    return values


def boosted(values):
    return all(values.get(field) == 1024 for field in FIELDS)


def natural(values):
    return all(values.get(field) == (0 if field.endswith('.min') else 1024) for field in FIELDS)


def snapshot(roots):
    """Walk only owned benchmark descendants, including children of worker threads."""
    started = time.monotonic()
    pending = list(roots)
    visited, processes, errors = set(), {}, []
    while pending:
        pid = pending.pop()
        if pid in visited:
            continue
        visited.add(pid)
        path = Path(f'/proc/{pid}')
        try:
            if path.stat().st_uid != os.getuid():
                errors.append(f'Benchmark descendant {pid} has another owner')
                continue
            raw = (path / 'stat').read_text()
            fields = raw[raw.rfind(')') + 2:].split()
            threads = {}
            for directory in (path / 'task').iterdir():
                try:
                    tid = int(directory.name)
                    pending.extend(map(int, (directory / 'children').read_text().split()))
                    threads[tid] = task(tid)
                except (FileNotFoundError, ProcessLookupError):
                    pass
            if threads:
                processes[pid] = dict(name=raw[raw.find('(') + 1:raw.rfind(')')],
                                      start_ticks=int(fields[19]), threads=threads)
        except (FileNotFoundError, ProcessLookupError):
            pass
        except (PermissionError, RuntimeError) as error:
            errors.append(str(error))
    observer = task(os.getpid())
    return dict(time=time.time(), observer=observer, roots=list(roots), processes=processes,
                errors=errors, verified=bool(processes) and not errors and natural(observer) and
                all(boosted(value) for process in processes.values() for value in process['threads'].values()),
                observer_duration_ms=(time.monotonic() - started) * 1000)


def phase_frequency(samples, selected):
    weighted = duration = 0
    for previous, sample in zip(samples, samples[1:]):
        for cpu in selected:
            frequency = sample['frequency_khz'].get(cpu)
            if frequency is not None:
                weight = sample['selected_busy'].get(cpu, 0) * (sample['time'] - previous['time'])
                weighted += weight * frequency
                duration += weight
    return weighted / duration if duration else None


def pair_eligibility(attempts, node, frequency_limit):
    chosen = {role: next((row for row in reversed(attempts)
                          if row['node'] == node and row['role'] == role and row['accepted']), None)
              for role in ('corgi', 'herdr')}
    phases = []
    if all(chosen.values()):
        herdr = {row['name']: row for row in chosen['herdr']['results']}
        for corgi in chosen['corgi']['results']:
            peer = herdr.get(corgi['name'], {})
            a, b = (row.get('selected_busy_weighted_observed_khz') for row in (corgi, peer))
            mismatch = max(a, b) / min(a, b) - 1 if a and b else None
            phases.append(dict(name=corgi['name'], corgi_khz=a, herdr_khz=b,
                               relative_difference=mismatch, eligible=mismatch is not None and mismatch <= frequency_limit))
    return dict(node=node, attempts={role: row['name'] if row else None for role, row in chosen.items()},
                frequency_relative_difference_limit=frequency_limit, phases=phases,
                eligible=bool(phases) and all(row['eligible'] for row in phases),
                note='Reported selected-core busy-weighted frequencies are an environmental guard, not effective per-process cycles.')
