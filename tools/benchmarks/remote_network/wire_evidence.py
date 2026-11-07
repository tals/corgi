#!/usr/bin/env python3
"""Export compact, audited evidence from three external bridge captures."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import shutil
import zlib


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export(root, name, output):
    manifest = read(root / "manifest.json")
    summary = read(root / "wire-summary.json")
    messages = [
        json.loads(line)
        for line in (root / "wire-messages.jsonl").read_text().splitlines()
    ]
    events = [
        json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()
    ]
    [result] = read(root / "results.json")
    assert result["case"] == "wire_capture"
    assert len(result["producers"]) == 12 and all(
        p["alive"] for p in result["producers"]
    )
    selected = next(
        p for p in result["producers"] if p["source"] == "atlas-source.json"
    )
    assert (selected["cols"], selected["rows"], selected["mode"]["hz"]) == (132, 47, 20)
    assert (
        events[-1]["event"] == "cleanup_complete"
        and not events[-1]["namespaces_remaining"]
    )
    assert not summary["partial_lines"] and summary["full_surfaces"] == 0
    assert summary["patches"] > 0
    by_direction = collections.Counter()
    for message in messages:
        by_direction[message["direction"]] += message["bytes"]
    assert dict(by_direction) == summary["syscall_bytes"]
    compression = collections.Counter()
    compressors = {
        d: zlib.compressobj(1, strategy=zlib.Z_HUFFMAN_ONLY) for d in ["up", "down"]
    }
    for message in messages:
        if manifest["product"] == "herdr":
            payload = bytes.fromhex(message["payload_hex"])
            payload = len(payload).to_bytes(4, "little") + payload
        else:
            payload = (
                json.dumps(
                    message["value"], ensure_ascii=False, separators=(",", ":")
                ).encode()
                + b"\n"
            )
        assert len(payload) == message["bytes"]
        direction = message["direction"]
        compressor = compressors[direction]
        compression[direction] += len(
            compressor.compress(payload) + compressor.flush(zlib.Z_PARTIAL_FLUSH)
        )
    compact = {k: v for k, v in summary.items() if k != "frames"}
    compact.update(
        {
            "manifest": manifest,
            "capture_seconds": result["end"] - result["start"],
            "all_12_producers_alive": True,
            "selected_pty": {"cols": 132, "rows": 47, "hz": 20},
            "namespaces_remaining": [],
            "message_bytes_match_syscalls": True,
            "huffman_replay_bytes": dict(compression),
            "compression_method": "Independent zlib streams per direction, level 1, Z_HUFFMAN_ONLY, Z_PARTIAL_FLUSH after each application message; no SSH/TCP headers or packetization.",
            "raw_files_sha256": {
                p.name: digest(p) for p in root.glob("wire.*") if p.suffix[1:].isdigit()
            },
            "messages_sha256": digest(root / "wire-messages.jsonl"),
            "capture_harness_sha256": read(root / "harness.json")["wire_capture.py"],
        }
    )
    if manifest["product"] == "corgi":
        replay = read(root / "compact-replay.json")
        original = replay["variants"][0]
        for direction, count in compression.items():
            assert original[direction + "_huffman_bytes"] == count
        assert len({v["decoded_semantic_sha256"] for v in replay["variants"]}) == 1
        assert all(
            v["all_decoded_messages_equal"] and v["messages_verified"] == len(messages)
            for v in replay["variants"]
        )
        render_components = {
            k: v for k, v in replay["components_raw_bytes"].items() if ":" not in k
        }
        assert (
            sum(render_components.values())
            == summary["groups"]["down:viewer.frame"]["bytes"]
        )
        text_parts = collections.Counter()
        widths = collections.Counter()
        for message in messages:
            if message["kind"] != "viewer.frame":
                continue
            for patch in message["value"]["view"]["patches"]:
                for row in patch["surface"]["lines"]:
                    line = row["line"]
                    plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line)
                    assert plain.isascii()
                    widths[len(plain)] += 1
                    encoded = json.dumps(line, ensure_ascii=False).encode()
                    text_parts["nonpadding_text"] += len(plain.rstrip(" "))
                    text_parts["trailing_spaces"] += len(plain) - len(plain.rstrip(" "))
                    text_parts["ansi_sequences"] += len(line.encode()) - len(plain)
                    text_parts["json_escaping_and_quotes"] += len(encoded) - len(
                        line.encode()
                    )
        assert sum(text_parts.values()) == render_components["changed_row_strings"]
        compact["row_string_bytes"] = dict(text_parts)
        compact["ascii_row_width_counts"] = dict(widths)
        compact["metadata_and_envelope_fraction_of_render"] = (
            render_components["patch_metadata_and_syntax"]
            + render_components["frame_envelope_and_view_metadata"]
        ) / sum(render_components.values())
        compact["replay_downstream_huffman_reduction"] = {
            v["name"]: 1 - v["down_huffman_bytes"] / original["down_huffman_bytes"]
            for v in replay["variants"]
        }
        shutil.copyfile(root / "compact-replay.json", output / f"{name}-replay.json")
        example = next(
            m
            for m in messages
            if m["kind"] == "viewer.frame" and m["value"]["view"]["patches"]
        )
    else:
        compact["changed_cells_per_patch"] = (
            summary["changed_cells"] / summary["patches"]
        )
        example = {"message": messages[0], "decoded_rows": summary["frames"][0]}
    write(output / f"{name}-sample.json", example)
    debug = (root / "ssh-debug.log").read_text()
    negotiation = [
        line
        for line in debug.splitlines()
        if "compression:" in line or "Enabling compression" in line
    ]
    assert any("zlib@openssh.com" in line for line in negotiation)
    assert any("Enabling compression" in line for line in negotiation)
    (output / f"{name}-ssh.txt").write_text("\n".join(negotiation) + "\n")
    return compact


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("corgi_sparse", type=Path)
    parser.add_argument("herdr_sparse", type=Path)
    parser.add_argument("corgi_dense", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    captures = {}
    for name in ["corgi_sparse", "herdr_sparse", "corgi_dense"]:
        captures[name] = export(
            getattr(args, name), name.replace("_", "-"), args.output
        )
    write(args.output / "captures.json", captures)
    write(
        args.output / "analysis-tools.json",
        {p.name: digest(p) for p in Path(__file__).parent.glob("wire_*.py")},
    )
    print(
        json.dumps(
            {"captures": len(captures), "audit": "passed", "output": str(args.output)}
        )
    )


if __name__ == "__main__":
    main()
