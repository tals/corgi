#!/usr/bin/env python3
"""Run the throughput/recovery comparison under one shared benchmark lock."""
import argparse
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('before')
    parser.add_argument('after')
    parser.add_argument('herdr')
    parser.add_argument('output')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--parallel', action='store_true', help='overlap suites on 72 separate CPUs (requires CPUs 32–119)')
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    lock = open(f'/tmp/corgi-cpu-benchmark-{os.getuid()}.lock', 'a')
    print('Waiting for the shared benchmark slot', flush=True)
    fcntl.flock(lock, fcntl.LOCK_EX)
    started = Path(f'/proc/{os.getpid()}/stat').read_text().rsplit(')', 1)[1].split()[19]
    env = dict(os.environ, CORGI_CPU_BENCHMARK_LOCK=f'{os.getpid()}:{started}')
    script = str(Path(__file__).with_name('outages.py'))
    binaries = [str(Path(b).resolve()) for b in [args.before, args.after, args.herdr]]
    fault_cases = 'blackhole2,blackhole3,blackhole4,blackhole5,blackhole7,blackhole35'
    sets = ['32-39;48-55;64-71', '72-79;80-87;88-95', '96-103;104-111;112-119'] if args.parallel else ['32-39;48-55;64-71'] * 3
    jobs = [
        [('stream-120', ['--suite', 'stream', '--stream-rtt', '120', '--stream-cases', 'dense:unlimited,dense:1mbit,dense:256kbit,dense:64kbit,sparse:64kbit,loss']),
         ('stream-20', ['--suite', 'stream', '--stream-rtt', '20', '--stream-cases', 'dense:unlimited,dense:1mbit']),
         ('stream-300', ['--suite', 'stream', '--stream-rtt', '300', '--stream-cases', 'dense:1mbit'])],
        [('faults-dense', ['--fault-kind', 'dense', '--cases', fault_cases])],
        [('faults-sparse', ['--fault-kind', 'sparse', '--cases', fault_cases])],
    ]
    commands = [[(name, [sys.executable, script, *binaries, str(root / name), '--repeats', str(args.repeats), '--cpu-sets', cpus, *extra]) for name, extra in job] for job, cpus in zip(jobs, sets)]
    (root / 'matrix.json').write_text(json.dumps({'args': vars(args), 'commands': commands}, indent=2) + '\n')
    writing, stopped, children = threading.Lock(), threading.Event(), set()

    def stop(_signal, _frame):
        stopped.set()
        with writing:
            for child in children:
                if child.poll() is None:
                    child.send_signal(signal.SIGINT)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    def record(**fields):
        with writing, (root / 'execution.jsonl').open('a') as out:
            out.write(json.dumps({'epoch': time.time(), **fields}) + '\n')

    def job(commands):
        for name, command in commands:
            record(event='start', name=name, command=command)
            with (root / f'{name}.log').open('w') as log:
                with writing:
                    if stopped.is_set():
                        return 130
                    child = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT)
                    children.add(child)
                code = child.wait()
                with writing:
                    children.remove(child)
            record(event='exit', name=name, code=code)
            print(json.dumps({'name': name, 'code': code}), flush=True)
            if code:
                return code
        return 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=3 if args.parallel else 1) as pool:
        codes = list(pool.map(job, commands))
    return int(stopped.is_set() or any(codes))


if __name__ == '__main__':
    raise SystemExit(main())
