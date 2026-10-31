"""Continuous-load host reference, run only outside application CPU windows."""
import hashlib
import os
from pathlib import Path
import resource
import subprocess
import time

import cost_clamp


def metadata(env):
    binary = Path('/usr/bin/openssl').resolve()
    libraries = subprocess.check_output(['ldd', str(binary)], text=True, env=env)
    crypto = next(Path(line.split('=>', 1)[1].split()[0]).resolve()
                  for line in libraries.splitlines() if 'libcrypto.so' in line and '=>' in line)
    return dict(binary=str(binary), binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                libcrypto=str(crypto), libcrypto_sha256=hashlib.sha256(crypto.read_bytes()).hexdigest(),
                version=subprocess.check_output([str(binary), 'version'], text=True, env=env).strip())


def throughput(stdout):
    rows = [line for line in stdout.splitlines() if line.startswith('+F:')]
    if len(rows) != 1:
        raise ValueError('Expected one OpenSSL throughput row for the fixed buffer size')
    value = float(rows[0].rsplit(':', 1)[1])
    if value <= 0:
        raise ValueError('Invalid OpenSSL calibration throughput')
    return value


def run(cpus, node, clamp):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('OPENSSL_') and key not in ('LD_PRELOAD', 'LD_LIBRARY_PATH')}
    result = dict(started_at=time.time(), metadata=metadata(env), samples=[], outside_application_windows=True,
                  note='Continuous SHA-256 throughput is a drift diagnostic; never normalize application CPU by it.')
    for cpu in sorted(cpus):
        command = ['numactl', '--all', f'--physcpubind={cpu}', f'--membind={node}',
                   '/usr/bin/openssl', 'speed', '-evp', 'sha256', '-bytes', '4096', '-seconds', '1', '-elapsed', '-mr']
        if clamp:
            command = ['uclampset', '-m', '1024', '-M', '1024', *command]
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        start = time.monotonic()
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        requested = None
        if clamp:
            deadline = time.monotonic() + 0.5
            while child.poll() is None and time.monotonic() < deadline:
                try:
                    requested = cost_clamp.task(child.pid)
                    if cost_clamp.boosted(requested):
                        break
                except (FileNotFoundError, ProcessLookupError):
                    pass
                time.sleep(0.005)
        stdout, stderr = child.communicate()
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        sample = dict(cpu=cpu, node=node, command=command, returncode=child.returncode,
                      stdout=stdout, stderr=stderr, clamps=requested,
                      wall_seconds=time.monotonic() - start,
                      user_seconds=after.ru_utime - before.ru_utime,
                      system_seconds=after.ru_stime - before.ru_stime)
        try:
            sample['bytes_per_second'] = throughput(stdout)
            sample['valid'] = child.returncode == 0 and (not clamp or bool(requested) and cost_clamp.boosted(requested))
        except ValueError as error:
            sample['valid'] = False
            sample['error'] = str(error)
        result['samples'].append(sample)
    result['finished_at'] = time.time()
    result['valid'] = all(sample['valid'] for sample in result['samples'])
    return result


def compare(before, after):
    old = {sample['cpu']: sample for sample in before['samples']}
    drifts = []
    for sample in after['samples']:
        first = old.get(sample['cpu'])
        if first and first['valid'] and sample['valid']:
            a, b = first['bytes_per_second'], sample['bytes_per_second']
            drifts.append(dict(cpu=sample['cpu'], before_bytes_per_second=a, after_bytes_per_second=b,
                               relative_difference=max(a, b) / min(a, b) - 1))
    valid = before['valid'] and after['valid'] and before['metadata'] == after['metadata']
    return dict(valid=valid, flag_threshold=0.10, per_cpu=drifts,
                drift_flag=not valid or any(row['relative_difference'] > 0.10 for row in drifts),
                note='A predeclared environmental flag for review; neither a CPU correction nor automatic product eligibility.')
