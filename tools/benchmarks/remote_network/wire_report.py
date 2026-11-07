#!/usr/bin/env python3
"""Reassemble Corgi JSON or Herdr bincode at an unchanged native SSH bridge."""
import argparse
import collections
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument("root")
args = parser.parse_args()
root = Path(args.root)
product = json.loads((root / "manifest.json").read_text())["product"]
pattern = re.compile(
    r'^(\d+\.\d+) (read|write)\((\d+), "((?:\\x[0-9a-f]{2})*)", \d+\)\s+= (\d+)'
)
messages = []
leftovers = []
syscall_bytes = collections.Counter()
for path in root.glob("wire.*"):
    if not path.suffix[1:].isdigit():
        continue
    buffers = {"up": b"", "down": b""}
    for line in path.read_text().splitlines():
        m = pattern.match(line)
        if not m:
            # A blocked read at detach has no bytes; successful I/O must parse.
            assert not re.search(r" (read\(0,|write\(1,).*\)\s+= [1-9]\d*", line), (
                path,
                line[:100],
            )
            continue
        epoch, op, fd, payload, count = m.groups()
        direction = (
            "up"
            if (op, fd) == ("read", "0")
            else "down" if (op, fd) == ("write", "1") else None
        )
        if not direction or int(count) == 0:
            continue
        data = bytes.fromhex(payload.replace("\\x", ""))[: int(count)]
        assert len(data) == int(count), (path, line[:100])
        syscall_bytes[direction] += len(data)
        buffers[direction] += data
        if product == "herdr":
            while len(buffers[direction]) >= 4:
                length = int.from_bytes(buffers[direction][:4], "little")
                assert 0 < length <= 32 * 1024 * 1024, (path, length)
                if len(buffers[direction]) < length + 4:
                    break
                payload = buffers[direction][4 : length + 4]
                buffers[direction] = buffers[direction][length + 4 :]
                messages.append(
                    {
                        "pid": int(path.suffix[1:]),
                        "epoch": float(epoch),
                        "direction": direction,
                        "bytes": length + 4,
                        "payload_hex": payload.hex(),
                    }
                )
            continue
        while b"\n" in buffers[direction]:
            raw, buffers[direction] = buffers[direction].split(b"\n", 1)
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                leftovers.append(
                    {
                        "file": str(path),
                        "direction": direction,
                        "bytes": len(raw) + 1,
                        "reason": "invalid or partial JSON line",
                    }
                )
                continue
            messages.append(
                {
                    "pid": int(path.suffix[1:]),
                    "epoch": float(epoch),
                    "direction": direction,
                    "bytes": len(raw) + 1,
                    "value": value,
                }
            )
    for direction, remaining in buffers.items():
        if remaining:
            leftovers.append(
                {
                    "file": str(path),
                    "direction": direction,
                    "bytes": len(remaining),
                    "reason": "incomplete last line",
                }
            )
messages.sort(key=lambda m: m["epoch"])
for direction, count in syscall_bytes.items():
    assert count == sum(
        m["bytes"] for m in messages if m["direction"] == direction
    ) + sum(m["bytes"] for m in leftovers if m["direction"] == direction)
if product == "herdr":

    class Reader:
        def __init__(self, data):
            self.data = data
            self.pos = 0

        def take(self, n):
            end = self.pos + n
            assert end <= len(self.data)
            value = self.data[self.pos : end]
            self.pos = end
            return value

        def uint(self):
            marker = self.take(1)[0]
            return (
                marker
                if marker < 251
                else int.from_bytes(
                    self.take({251: 2, 252: 4, 253: 8, 254: 16}[marker]), "little"
                )
            )

        def string(self):
            return self.take(self.uint()).decode()

    groups = collections.defaultdict(lambda: {"messages": 0, "bytes": 0})
    frames = []
    for row in messages:
        r = Reader(bytes.fromhex(row["payload_hex"]))
        variant = r.uint()
        kind = (
            {13: "PaneSurface", 19: "PaneSurfacePatch", 20: "EndpointControl"}.get(
                variant, f"variant-{variant}"
            )
            if row["direction"] == "down"
            else f"variant-{variant}"
        )
        row["kind"] = kind
        g = groups[row["direction"] + ":" + kind]
        g["messages"] += 1
        g["bytes"] += row["bytes"]
        if row["direction"] == "down" and variant == 19:
            boot = r.string()
            projection, base, revision = r.uint(), r.uint(), r.uint()
            spans = []
            for _ in range(r.uint()):
                x, y, count = r.uint(), r.uint(), r.uint()
                symbols = []
                for _ in range(count):
                    symbols.append(r.string())
                    r.uint()
                    r.uint()
                    r.uint()
                    assert r.take(1)[0] in [0, 1]
                    option = r.take(1)[0]
                    assert option in [0, 1]
                    if option:
                        r.uint()
                spans.append({"x": x, "y": y, "cells": count, "text": "".join(symbols)})
            frames.append(
                {
                    "epoch": row["epoch"],
                    "bytes": row["bytes"],
                    "boot": boot,
                    "projection": projection,
                    "base": base,
                    "revision": revision,
                    "spans": spans,
                    "cells": sum(s["cells"] for s in spans),
                    "metadata_tail_bytes": len(r.data) - r.pos,
                }
            )
    summary = {
        "root": str(root.resolve()),
        "product": product,
        "groups": dict(groups),
        "frames": frames,
        "partial_lines": leftovers,
        "syscall_bytes": dict(syscall_bytes),
        "full_surfaces": groups["down:PaneSurface"]["messages"],
        "patches": len(frames),
        "changed_cells": sum(f["cells"] for f in frames),
    }
    (root / "wire-messages.jsonl").write_text(
        "".join(json.dumps(m, separators=(",", ":")) + "\n" for m in messages)
    )
    (root / "wire-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "frames"}, indent=2))
    raise SystemExit(0)
requests = {}
groups = collections.defaultdict(lambda: {"messages": 0, "bytes": 0})
frames = []


def size(v):
    return len(json.dumps(v, separators=(",", ":"), ensure_ascii=False).encode())


for row in messages:
    v = row["value"]
    pid = row["pid"]
    if row["direction"] == "up":
        kind = v.get("op", "unclassified")
        requests[(pid, v.get("request_id"))] = kind
    else:
        kind = v.get("type") or "reply:" + requests.get(
            (pid, v.get("request_id")), "unknown"
        )
    row["kind"] = kind
    group = groups[row["direction"] + ":" + kind]
    group["messages"] += 1
    group["bytes"] += row["bytes"]
    if kind == "viewer.frame":
        view = v["view"]
        frames.append(
            {
                "epoch": row["epoch"],
                "bytes": row["bytes"],
                "serial": v.get("frame"),
                "full_surfaces": len(view.get("surfaces", [])),
                "patches": len(view.get("patches", [])),
                "changed_rows": sum(
                    len(p["surface"]["lines"]) for p in view.get("patches", [])
                ),
                "fields": {k: size(x) for k, x in view.items()},
            }
        )
(root / "wire-messages.jsonl").write_text(
    "".join(json.dumps(m, separators=(",", ":")) + "\n" for m in messages)
)
summary = {
    "root": str(root.resolve()),
    "product": product,
    "groups": dict(groups),
    "frames": frames,
    "partial_lines": leftovers,
    "syscall_bytes": dict(syscall_bytes),
    "frame_fields_bytes": {
        k: sum(f["fields"].get(k, 0) for f in frames)
        for k in set(k for f in frames for k in f["fields"])
    },
    "full_surfaces": sum(f["full_surfaces"] for f in frames),
    "patches": sum(f["patches"] for f in frames),
    "changed_row_counts": dict(collections.Counter(f["changed_rows"] for f in frames)),
}
(root / "wire-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({k: v for k, v in summary.items() if k not in ["frames"]}, indent=2))
