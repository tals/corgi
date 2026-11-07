#!/usr/bin/env python3
"""Losslessly replay captured frames with metadata reuse and optional row splices.

This is an offline format experiment, not a supported application wire format.
"""
import argparse
import collections
import copy
import hashlib
import json
from pathlib import Path
import zlib


def encode(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":")).encode()


def difference(before, after):
    if not isinstance(before, dict) or not isinstance(after, dict):
        return copy.deepcopy(after)
    delta = {}
    for k, v in after.items():
        if k not in before:
            delta[k] = copy.deepcopy(v)
        elif before[k] != v:
            delta[k] = difference(before[k], v)
    removed = [k for k in before if k not in after]
    if removed:
        delta["$drop"] = removed
    return delta


def merge(before, delta):
    if not isinstance(before, dict) or not isinstance(delta, dict):
        return copy.deepcopy(delta)
    after = copy.deepcopy(before)
    for k in delta.get("$drop", []):
        del after[k]
    for k, v in delta.items():
        if k != "$drop":
            after[k] = merge(after.get(k), v)
    return after


class Codec:
    def __init__(self, metadata, spans):
        self.metadata, self.spans = metadata, spans
        self.view = {}
        self.panes = {}
        self.rows = {}

    def transform(self, original, decoding=False):
        if original.get("type") != "viewer.frame":
            return copy.deepcopy(original)
        result = copy.deepcopy(original)
        v = result["view"]
        patches = v.pop("patches", [])
        if self.metadata:
            if decoding:
                v = merge(self.view, v)
                self.view = copy.deepcopy(v)
            else:
                delta = difference(self.view, v)
                self.view = copy.deepcopy(v)
                v = delta
        output = []
        for p in patches:
            pane = p["surface"]["pane"]
            lines = p["surface"].pop("lines")
            if self.metadata:
                if decoding:
                    p = merge(self.panes.get(pane, {}), p)
                    self.panes[pane] = copy.deepcopy(p)
                else:
                    delta = difference(self.panes.get(pane, {}), p)
                    self.panes[pane] = copy.deepcopy(p)
                    p = delta
                    p.setdefault("surface", {})["pane"] = pane
            changed = []
            for row in lines:
                key = (pane, row["row"])
                before = self.rows.get(key)
                if decoding and "at" in row:
                    assert before is not None
                    at, remove = row["at"], row["remove"]
                    assert 0 <= at <= len(before) and 0 <= remove <= len(before) - at
                    row = {
                        "row": row["row"],
                        "line": before[:at] + row["line"] + before[at + remove :],
                    }
                after = row["line"]
                self.rows[key] = after
                if not decoding and self.spans and before is not None:
                    prefix = 0
                    while (
                        prefix < min(len(before), len(after))
                        and before[prefix] == after[prefix]
                    ):
                        prefix += 1
                    suffix = 0
                    while (
                        suffix < min(len(before), len(after)) - prefix
                        and before[-suffix - 1] == after[-suffix - 1]
                    ):
                        suffix += 1
                    splice = {
                        "row": row["row"],
                        "at": prefix,
                        "remove": len(before) - prefix - suffix,
                        "line": after[prefix : len(after) - suffix],
                    }
                    if len(encode(splice)) < len(encode(row)):
                        row = splice
                changed.append(row)
            p.setdefault("surface", {})["lines"] = changed
            output.append(p)
        v["patches"] = output
        result["view"] = v
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    args = parser.parse_args()
    root = Path(args.root)
    rows = [
        json.loads(l) for l in (root / "wire-messages.jsonl").read_text().splitlines()
    ]
    summary = json.loads((root / "wire-summary.json").read_text())
    assert summary["product"] == "corgi" and not summary["partial_lines"]
    # This prototype handles established streams only, not snapshot/reset semantics.
    assert summary["full_surfaces"] == 0
    events = [json.loads(l) for l in (root / "events.jsonl").read_text().splitlines()]
    seconds = next(e["at"] for e in events if e["event"] == "wire_capture_end") - next(
        e["at"] for e in events if e["event"] == "wire_capture_start"
    )
    components = collections.Counter()
    full = 0
    patches = 0
    for row in rows:
        raw = encode(row["value"]) + b"\n"
        assert len(raw) == row["bytes"]
        if row["kind"] != "viewer.frame":
            components[row["direction"] + ":" + row["kind"]] += len(raw)
            continue
        total_patches = 0
        for p in row["value"]["view"]["patches"]:
            lines = p["surface"]["lines"]
            texts = sum(len(encode(r["line"])) for r in lines)
            components["changed_row_strings"] += texts
            components["row_indices_and_syntax"] += len(encode(lines)) - texts
            components["patch_metadata_and_syntax"] += len(encode(p)) - len(
                encode(lines)
            )
            total_patches += len(encode(p))
            patches += 1
        components["frame_envelope_and_view_metadata"] += len(raw) - total_patches
        full += len(row["value"]["view"]["surfaces"])
    variants = []
    for name, metadata, spans in [
        ("original", False, False),
        ("metadata_reuse", True, False),
        ("row_splices", False, True),
        ("both", True, True),
    ]:
        sender, receiver = Codec(metadata, spans), Codec(metadata, spans)
        compressors = {
            d: zlib.compressobj(level=1, strategy=zlib.Z_HUFFMAN_ONLY)
            for d in ["up", "down"]
        }
        dictionary = {d: zlib.compressobj(level=6) for d in ["up", "down"]}
        counts = collections.Counter()
        original_hash = hashlib.sha256()
        decoded_hash = hashlib.sha256()
        frames = 0
        for row in rows:
            before = row["value"]
            compact = sender.transform(before)
            decoded = receiver.transform(compact, decoding=True)
            assert decoded == before, (name, row["epoch"])
            original_hash.update(
                json.dumps(
                    before, sort_keys=True, ensure_ascii=False, separators=(",", ":")
                ).encode()
            )
            decoded_hash.update(
                json.dumps(
                    decoded, sort_keys=True, ensure_ascii=False, separators=(",", ":")
                ).encode()
            )
            direction = row["direction"]
            data = encode(compact) + b"\n"
            counts[direction + "_raw_bytes"] += len(data)
            counts[direction + "_huffman_bytes"] += len(
                compressors[direction].compress(data)
                + compressors[direction].flush(zlib.Z_PARTIAL_FLUSH)
            )
            counts[direction + "_dictionary_bytes"] += len(
                dictionary[direction].compress(data)
                + dictionary[direction].flush(zlib.Z_PARTIAL_FLUSH)
            )
            frames += before.get("type") == "viewer.frame"
        # Equality is semantic: encoding an equivalent dict may change key order.
        assert original_hash.digest() == decoded_hash.digest()
        variants.append(
            {
                "name": name,
                "frames_verified": frames,
                "messages_verified": len(rows),
                "all_decoded_messages_equal": True,
                "decoded_semantic_sha256": decoded_hash.hexdigest(),
                **dict(counts),
            }
        )
    result = {
        "capture": str(root.resolve()),
        "seconds": seconds,
        "components_raw_bytes": dict(components),
        "full_surfaces": full,
        "patches": patches,
        "variants": variants,
        "method": "Offline lossless reconstruction; Huffman-only zlib at per-message flush boundaries. Excludes SSH framing, TCP and ACK overhead. Dictionary coding is a historical counterfactual only, not a configuration recommendation.",
    }
    (root / "compact-replay.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
