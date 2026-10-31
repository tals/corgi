"""Read-only host context; cpufreq values are observations, not effective cycle counters."""
from pathlib import Path
import time


def frequencies(cpus):
    result = {}
    for cpu in sorted(cpus):
        try:
            result[cpu] = int(Path(f'/sys/devices/system/cpu/cpu{cpu}/cpufreq/scaling_cur_freq').read_text())
        except (FileNotFoundError, PermissionError, ValueError):
            result[cpu] = None
    return result


def frequency_policy(cpus):
    result = {}
    for cpu in sorted(cpus):
        root = Path(f'/sys/devices/system/cpu/cpu{cpu}/cpufreq')
        fields = {}
        for name in ['scaling_driver', 'scaling_governor', 'scaling_min_freq', 'scaling_max_freq', 'scaling_available_frequencies', 'affected_cpus', 'related_cpus', 'freqdomain_cpus', 'boost', 'cpb', 'stats/time_in_state']:
            try:
                fields[name] = (root / name).read_text().strip()
            except (FileNotFoundError, PermissionError):
                pass
        result[cpu] = fields
    return result


def population():
    processes = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            raw = (path / 'stat').read_text()
            fields = raw[raw.rfind(')') + 2:].split()
            processes.append(dict(pid=int(path.name), comm=raw[raw.find('(') + 1:raw.rfind(')')],
                                  ppid=int(fields[1]), state=fields[0], threads=int(fields[17]),
                                  ticks=int(fields[11]) + int(fields[12]), start_ticks=int(fields[19]), cpu=int(fields[36])))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return dict(at=time.time(), outside_cpu_window=True, process_count=len(processes),
                thread_count=sum(p['threads'] for p in processes), processes=processes)
