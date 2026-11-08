#!/usr/bin/env python3
"""Run the Bun API comparison against frozen compression holdouts."""
import argparse
import collections
import fcntl
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--cpu", type=int, default=48)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--target-ms", type=int, default=150)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    os.sched_setaffinity(0, {args.cpu})
    lock = open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX)
    script = Path(__file__).with_name("compression_bun.ts")
    shutil.copyfile(script, args.out / script.name)
    shutil.copyfile(__file__, args.out / Path(__file__).name)
    modes = [
        "bun-sync",
        "node-sync",
        "node-sync-dict",
        "frame",
        "frame-dict",
        "live",
        "live-dict",
        "deflate",
        "huffman",
        "ffi-dict",
    ]
    jobs = [
        (dataset, mode, repetition)
        for dataset in ("sparse", "dense", "claude", "codex")
        for mode in modes
        for repetition in range(args.repeats)
    ]
    random.Random(20261108).shuffle(jobs)
    rows = []
    with (args.out / "trials.jsonl").open("w") as output:
        for index, (dataset, mode, repetition) in enumerate(jobs):
            dictionary = (
                args.corpus / "agent-training-8192.dict"
                if mode.endswith("-dict")
                else "-"
            )
            row = json.loads(
                subprocess.check_output(
                    [
                        "bun",
                        str(script),
                        str(args.corpus / f"{dataset}.corpus"),
                        mode,
                        str(dictionary),
                        str(args.target_ms),
                    ],
                    text=True,
                )
            )
            row.update(dataset=dataset, repetition=repetition)
            rows.append(row)
            output.write(json.dumps(row) + "\n")
            output.flush()
            if (index + 1) % 20 == 0:
                print(f"{index + 1}/{len(jobs)} Bun trials; all byte-exact", flush=True)
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row["dataset"], row["mode"]].append(row)
    summary = []
    for key, values in sorted(groups.items()):
        assert len(values) == args.repeats and all(v["roundtrip"] for v in values)
        row = {
            k: v
            for k, v in values[0].items()
            if k not in ("memory", "repetition", "sink")
        }
        for field in (
            "raw_bytes",
            "messages",
            "corpus_sha256",
            "dictionary_sha256",
            "dictionary_required",
        ):
            assert len({v[field] for v in values}) == 1, (key, field)
        for field in ("compressed_bytes", "warm_compressed_bytes", "setup_ms"):
            row[field] = statistics.median(v[field] for v in values)
            row[field + "_range"] = [
                min(v[field] for v in values),
                max(v[field] for v in values),
            ]
        row["all_pass_compressed_bytes_range"] = [
            min(v["compressed_bytes_range"][0] for v in values),
            max(v["compressed_bytes_range"][1] for v in values),
        ]
        for operation in ("encode", "decode"):
            row[operation] = {}
            for field in ("cpu_us_per_message", "wall_us_per_message"):
                measured = [v[operation][field] for v in values]
                row[operation][field] = statistics.median(measured)
                row[operation][field + "_range"] = [min(measured), max(measured)]
        row["repetitions"] = args.repeats
        summary.append(row)
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    metadata = {
        "cpu": args.cpu,
        "repeats": args.repeats,
        "target_cpu_ms": args.target_ms,
        "source_sha256": hashlib.sha256(script.read_bytes()).hexdigest(),
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "corpus_directory": str(args.corpus.resolve()),
        "all_byte_exact": True,
        "trial_count": len(rows),
        "matrix_cells": len(summary),
    }
    (args.out / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Wrote {args.out / 'summary.json'}", flush=True)


if __name__ == "__main__":
    main()
