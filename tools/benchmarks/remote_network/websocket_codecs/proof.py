#!/usr/bin/env python3
"""Independently check negotiated codecs and delivered bytes from packet headers."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct


def load(path):
    return json.loads(path.read_text())


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def packets(path):
    result = []
    with path.open("rb") as source:
        header = source.read(24)
        assert header[:4] == bytes.fromhex("d4c3b2a1")
        assert struct.unpack("<I", header[20:])[0] == 276, "Expected Linux SLL2"
        while header := source.read(16):
            seconds, micros, captured, original = struct.unpack("<IIII", header)
            data = source.read(captured)
            assert len(data) == captured
            # The capture's cooked header is 20 bytes; veth counters include Ethernet's 14.
            if data[10] == 4:
                continue  # outgoing; count each delivered packet at its receiving interface
            protocol = int.from_bytes(data[:2], "big")
            ip = data[20:]
            result.append(
                {
                    "epoch": seconds + micros / 1e6,
                    "ifindex": int.from_bytes(data[4:8], "big"),
                    "bytes": original - 20 + 14,
                    "protocol": protocol,
                    "source": (
                        ".".join(map(str, ip[12:16])) if protocol == 0x800 else None
                    ),
                }
            )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    checks, problems, evidence = [], [], {}

    def check(ok, description):
        (checks if ok else problems).append(description)

    for mode in ["identity", "zstd", "deflate", "herdr"]:
        path = args.root / mode
        events = lines(path / "events.jsonl")
        check(
            events[-1]["event"] == "cleanup_complete",
            mode + ": completed and cleaned up",
        )
        ssh = []
        for log in sorted((path / "ssh-debug").glob("*.log")):
            for line in log.read_text().splitlines():
                if "kex: " in line and "compression:" in line:
                    ssh.append({"file": str(log), "negotiated": line})
        expected = "zlib@openssh.com" if mode == "herdr" else "none"
        check(
            bool(ssh)
            and all(
                line["negotiated"].endswith("compression: " + expected) for line in ssh
            ),
            mode + ": actual SSH compression is " + expected,
        )
        connections = [] if mode == "herdr" else lines(path / "codec.jsonl")
        if mode != "herdr":
            check(
                len(connections) >= 2,
                mode + ": observed live WS connections to both remote machines",
            )
        for index, connection in enumerate(connections):
            up, down = connection["up"], connection["down"]
            prefix = f"{mode} connection {index}"
            check(
                "101 Switching Protocols" in down["header"],
                prefix + ": HTTP upgrade completed",
            )
            check(
                up["frames"] > 0 and down["frames"] > 0,
                prefix + ": bidirectional binary payload observed",
            )
            check(
                up["masked"] == up["frames"] and down["masked"] == 0,
                prefix + ": correct WS masking",
            )
            if mode == "deflate":
                check(
                    "Sec-WebSocket-Extensions: permessage-deflate\r\n"
                    in down["header"],
                    prefix + ": native PMD with context takeover",
                )
                check(
                    down["compressed"] == down["frames"],
                    prefix + ": server sets RSV1 on all binary messages",
                )
                check(
                    up["hello"] is not None and not up["hello"].get("accept_encoding"),
                    prefix + ": no stacked application zstd",
                )
            else:
                check(
                    "sec-websocket-extensions:" not in down["header"].lower(),
                    prefix + ": no native WS compression",
                )
                check(
                    up["compressed"] == down["compressed"] == 0, prefix + ": RSV1 clear"
                )
                offered = up["hello"].get("accept_encoding") if up["hello"] else None
                selected = (
                    down["hello"].get("content_encoding") if down["hello"] else None
                )
                check(
                    (
                        (offered == ["zstd"] and selected == "zstd")
                        if mode == "zstd"
                        else not offered and not selected
                    ),
                    prefix + ": correct application codec negotiation",
                )
        captures = {
            machine: packets(path / f"packets-{machine}.pcap")
            for machine in ["local", "atlas"]
        }
        packet_checks = []
        offset = events[0]["epoch"] - events[0]["at"]
        for row in load(path / "results.json"):
            if row["case"] != "stream":
                continue
            snapshots = [
                load(path / f"network-{row['snapshot_prefix']}-{point}.json")
                for point in ["start", "end"]
            ]
            for machine, interface in [("local", "atlas"), ("atlas", "uplink")]:
                first, last = [snapshot[machine] for snapshot in snapshots]
                links = [
                    next(
                        link
                        for link in json.loads(snapshot["links"])
                        if link["ifname"] == interface
                    )
                    for snapshot in [first, last]
                ]
                counter = (
                    links[1]["stats64"]["rx"]["bytes"]
                    - links[0]["stats64"]["rx"]["bytes"]
                )
                selected = [
                    packet
                    for packet in captures[machine]
                    if packet["ifindex"] == links[0]["ifindex"]
                    and first["at"] + offset <= packet["epoch"] < last["at"] + offset
                ]
                captured = sum(packet["bytes"] for packet in selected)
                error = abs(counter - captured) / max(counter, 1)
                # Snapshot timestamps precede three subprocess reads. Short diagnostic windows
                # allow 5% skew; this checks the layer and direction, not sub-packet precision.
                check(
                    error < 0.05,
                    f"{mode} {row['kind']} {machine}: packet sum agrees with receiving-interface counter within 5%",
                )
                packet_checks.append(
                    {
                        "kind": row["kind"],
                        "receiver": machine,
                        "counter_bytes": counter,
                        "pcap_bytes": captured,
                        "relative_error": error,
                        "packets": len(selected),
                    }
                )
        logs = {
            machine: (path / f"packets-{machine}.log").read_text()
            for machine in captures
        }
        for machine, log in logs.items():
            check(
                bool(re.search(r"\b0 packets dropped by kernel", log)),
                f"{mode} {machine}: no capture drops",
            )
        evidence[mode] = {
            "manifest": load(path / "manifest.json"),
            "ssh": ssh,
            "connections": connections,
            "packet_checks": packet_checks,
            "capture_logs": logs,
            "capture_sha256": {
                machine: hashlib.sha256(
                    (path / f"packets-{machine}.pcap").read_bytes()
                ).hexdigest()
                for machine in captures
            },
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {"checks": checks, "problems": problems, "evidence": evidence}, indent=2
        )
        + "\n"
    )
    print(json.dumps({"checks": len(checks), "problems": problems}))
    return bool(problems)


if __name__ == "__main__":
    raise SystemExit(main())
