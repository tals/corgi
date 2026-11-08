#!/usr/bin/env python3
"""Independent kernel-counter check using known AF_UNIX socketpair transfers."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
a, b = socket.socketpair()
inode = lambda s: os.readlink(f"/proc/{os.getpid()}/fd/{s.fileno()}")[8:-1]
inodes = [inode(a), inode(b)]
sizes = [1, 125, 126, 127, 65535, 65536, 1048576] * 7
start = time.monotonic_ns() + 5_000_000_000
end = start + 3_000_000_000
command = ["sudo", "-n", "bpftrace", "-f", "json", str(Path(__file__).with_name("socket_bytes.bt")),
           str(os.getpid()), "0", str(start), str(end)]
probe = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
received = [0, 0]

def transfer(sender, receiver, direction):
    def drain():
        while received[direction] < sum(sizes):
            received[direction] += len(receiver.recv(65536))
    reader = threading.Thread(target=drain)
    reader.start()
    for size in sizes:
        sender.sendall(b"x" * size)
    reader.join(timeout=2)
    if reader.is_alive():
        raise RuntimeError("Receiver timed out")

time.sleep(max(0, (start - time.monotonic_ns()) / 1e9))
transfer(a, b, 0)
transfer(b, a, 1)
finished = time.monotonic_ns()
out, err = probe.communicate(timeout=10)
(args.output / "bpf.jsonl").write_text(out)
(args.output / "bpf.stderr").write_text(err)
measured = {}
ready = None
for line in out.splitlines():
    if line.strip():
        data = json.loads(line).get("data", {})
        if isinstance(data, dict):
            measured.update(data.get("@bytes", {}))
            ready = data.get("@ready_ns", ready)
expected = {f"{os.getpid()},{i}": sum(sizes) for i in inodes}
result = dict(command=command, expected=expected, measured=measured, received=received,
              ready_ns=ready, start_ns=start, end_ns=end, finished_ns=finished,
              passed=probe.returncode == 0 and measured == expected and ready < start and finished < end)
(args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
if not result["passed"]:
    raise SystemExit(1)
