#!/usr/bin/env python3
"""A timestamped terminal workload with an independent, durable input receipt."""
import fcntl
import json
import os
from pathlib import Path
import random
import select
import signal
import struct
import sys
import termios
import time
import tty

root, machine = Path(sys.argv[1]), sys.argv[2]
root.mkdir(parents=True, exist_ok=True)
tty.setraw(0)
os.set_blocking(0, False)
rng = random.Random(42)
seq, ack, pending = 0, "NONE", b""
events = (root / f"{machine}-input.jsonl").open("a", buffering=1)
state = root / "mode.json"
last_mode, lines = None, []
next_frame = time.monotonic()
while True:
    readable, _, _ = select.select([0], [], [], max(0, next_frame - time.monotonic()))
    if readable:
        data = os.read(0, 65536)
        if not data:
            break
        pending += data
        while b"\r" in pending or b"\n" in pending:
            cut = min(i for i in [pending.find(b"\r"), pending.find(b"\n")] if i >= 0)
            token, pending = pending[:cut], pending[cut + 1:]
            ack = token.decode("ascii", "replace")
            events.write(json.dumps({"at": time.monotonic(), "token": ack, "pid": os.getpid()}) + "\n")
    if time.monotonic() < next_frame:
        continue
    try:
        mode = json.loads(state.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        mode = {"kind": "sparse", "hz": 20}
    seq += 1
    if mode != last_mode:
        os.write(1, b"\x1b[2J\x1b[?25l")
        last_mode = mode
    if mode["kind"] == "dense":
        lines = ["".join(rng.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=108)) for _ in range(22)]
    else:
        lines = [f"build job {i:02d}: compiled module, tests passing; waiting for next task" for i in range(22)]
        lines[seq % 22] = f"build job {seq % 22:02d}: step {seq:08d} compiled module, tests passing"
    stamp = time.monotonic_ns()
    frame = f"\x1b[HNETEVAL_{machine} S{seq:08d} T{stamp}\x1b[K"
    frame += "".join(f"\x1b[{i+2};1H{line}\x1b[K" for i, line in enumerate(lines))
    frame += f"\x1b[25;1HEND_{machine} S{seq:08d} ACK_{ack}\x1b[K"
    os.write(1, frame.encode())
    if seq % 20 == 0:
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
        temporary = root / f"{machine}-source.tmp"
        temporary.write_text(json.dumps({"seq": seq, "at": stamp / 1e9, "pid": os.getpid(), "rows": rows, "cols": cols, "mode": mode}))
        temporary.replace(root / f"{machine}-source.json")
    next_frame = max(next_frame + 1 / mode["hz"], time.monotonic())
