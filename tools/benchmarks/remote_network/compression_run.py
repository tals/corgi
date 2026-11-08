#!/usr/bin/env python3
"""Train on whole sources, audit holdouts, then benchmark identical message bytes."""
import argparse
import collections
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import re
import statistics
import struct
import subprocess


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def capture(path):
    records = [json.loads(line) for line in path.read_text().splitlines()]
    messages = []
    for record in records:
        if record["direction"] != "down" or record["kind"] != "viewer.frame":
            continue
        raw = (
            json.dumps(record["value"], ensure_ascii=False, separators=(",", ":"))
            + "\n"
        ).encode()
        assert len(raw) == record["bytes"]
        messages.append(raw)
    # Check reserialization against the actual syscall payload, not just its length.
    observed = []
    pattern = re.compile(
        r'^\d+\.\d+ write\(1, "((?:\\x[0-9a-f]{2})*)", \d+\)\s+= (\d+)'
    )
    for trace in sorted(path.parent.glob("wire.*")):
        if not trace.suffix[1:].isdigit():
            continue
        pending = b""
        for line in trace.read_text().splitlines():
            match = pattern.match(line)
            if match:
                pending += bytes.fromhex(match[1].replace("\\x", ""))[: int(match[2])]
                while b"\n" in pending:
                    raw, pending = pending.split(b"\n", 1)
                    try:
                        value = json.loads(raw)
                    except ValueError:
                        continue
                    if value.get("type") == "viewer.frame":
                        observed.append(raw + b"\n")
    assert collections.Counter(observed) == collections.Counter(
        messages
    ), "RawWireMismatch"
    return messages


def packed(messages):
    return struct.pack("<I", len(messages)) + b"".join(
        struct.pack("<I", len(m)) + m for m in messages
    )


def run(args):
    return json.loads(subprocess.check_output([str(x) for x in args], text=True))


def summarize(directory):
    groups = collections.defaultdict(list)
    for line in (directory / "results.jsonl").read_text().splitlines():
        row = json.loads(line)
        groups[
            (row["dataset"], row["codec"], row["level"], row["dictionary_capacity"])
        ].append(row)
    summary = []
    expected = json.loads((directory / "manifest.json").read_text())["environment"][
        "repeats"
    ]
    assert len(groups) == 152
    for key, values in sorted(groups.items()):
        assert len(values) == expected and all(v["roundtrip"] for v in values)
        row = values[0].copy()
        for field in ("repetition", "encode_iterations", "decode_iterations"):
            row.pop(field)
        for field in (
            "encode_us_per_message",
            "decode_us_per_message",
            "setup_cpu_us",
            "cold_encode_us_per_message",
            "first_encode_us",
            "encoder_bytes",
            "decoder_bytes",
            "cdict_bytes",
            "ddict_bytes",
        ):
            measured = [v[field] for v in values]
            row[field] = (
                max(measured)
                if field.endswith("_bytes")
                else statistics.median(measured)
            )
            row[field + "_range"] = [min(measured), max(measured)]
        for field in (
            "raw_bytes",
            "compressed_bytes",
            "first_message_bytes",
            "stacked_ssh_bytes",
        ):
            assert len({v[field] for v in values}) == 1, (key, field)
        row["repetitions"] = len(values)
        summary.append(row)
    save(directory / "summary.json", summary)
    print(f"Wrote {directory / 'summary.json'}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-fixtures", type=Path, required=True)
    parser.add_argument("--test-sparse", type=Path, required=True)
    parser.add_argument("--test-dense", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cpu", type=int, default=48)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--target-ms", type=int, default=80)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    assert args.repeats > 0 and args.target_ms > 0
    args.out.mkdir(parents=True, exist_ok=True)
    os.sched_setaffinity(0, {args.cpu})
    # Share the lock with the network/CPU evaluation harnesses.
    lock = open(f"/tmp/corgi-cpu-benchmark-{os.getuid()}.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX)
    sources = {}
    manifest = {"sources": {}, "dictionaries": {}, "holdouts": {}}
    training_provenance = json.loads((args.train_fixtures / "sources.json").read_text())
    test_provenance = json.loads((args.fixtures / "sources.json").read_text())
    assert {
        training_provenance[s]["scenario_sha256"] for s in ("claude", "codex")
    }.isdisjoint(
        {test_provenance[s]["scenario_sha256"] for s in ("claude", "codex")}
    ), "SharedAgentScenario"
    manifest["replay_provenance"] = {
        "training": training_provenance,
        "test": test_provenance,
    }
    paths = {
        "train-claude": args.train_fixtures / "claude.jsonl",
        "train-codex": args.train_fixtures / "codex.jsonl",
        "sparse": args.test_sparse / "wire-messages.jsonl",
        "dense": args.test_dense / "wire-messages.jsonl",
        **{
            name: args.fixtures / f"{name}.jsonl"
            for name in ("claude", "codex", "micro", "shell")
        },
    }
    for name, path in paths.items():
        sources[name] = (
            capture(path)
            if name in ("sparse", "dense")
            else path.read_bytes().splitlines(keepends=True)
        )
        assert sources[name] and all(m.endswith(b"\n") for m in sources[name])
        data = packed(sources[name])
        (args.out / f"{name}.corpus").write_bytes(data)
        manifest["sources"][name] = {
            "path": str(path.resolve()),
            "source_sha256": sha(path.read_bytes()),
            "corpus_sha256": sha(data),
            "messages": len(sources[name]),
            "bytes": sum(map(len, sources[name])),
            "message_sha256": [sha(m) for m in sources[name]],
        }
    training = ["train-claude", "train-codex", "micro", "shell"]
    families = {"agent-training": training}
    tests = {name: "agent-training" for name in ("sparse", "dense", "claude", "codex")}
    for test, family in tests.items():
        assert test not in families[family] and f"old-{test}" not in families[family]
        training_paths = {paths[s].resolve() for s in families[family]}
        assert paths[test].resolve() not in training_paths
        train_hashes = {sha(m) for s in families[family] for m in sources[s]}
        overlap = train_hashes & {sha(m) for m in sources[test]}
        assert not overlap, f"TrainingLeakage: {test}"
        manifest["holdouts"][test] = {
            "family": family,
            "training_sources": families[family],
            "exact_message_overlap": len(overlap),
        }
    for family, names in families.items():
        path = args.out / f"train-{family}.corpus"
        samples = [m for name in names for m in sources[name]]
        random.Random(20261108).shuffle(samples)
        path.write_bytes(packed(samples))
        for capacity in (8192, 32768):
            name = f"{family}-{capacity}"
            dictionary = args.out / f"{name}.dict"
            result = run([args.binary, "train", path, dictionary, capacity])
            result.update(
                sources=names,
                sha256=sha(dictionary.read_bytes()),
                sample_shuffle_seed=20261108,
                capacity=capacity,
            )
            manifest["dictionaries"][name] = result
    manifest["environment"] = {
        "platform": platform.platform(),
        "cpu": args.cpu,
        "repeats": args.repeats,
        "target_cpu_ms_per_encode_or_decode": args.target_ms,
        "cpu_model": next(
            line.split(":", 1)[1].strip()
            for line in Path("/proc/cpuinfo").read_text().splitlines()
            if line.startswith("model name")
        ),
        "binary_sha256": sha(args.binary.read_bytes()),
        "compiler": subprocess.check_output(
            ["cc", "--version"], text=True
        ).splitlines()[0],
    }
    save(args.out / "manifest.json", manifest)
    if args.prepare_only:
        return
    jobs = []
    for test, family in tests.items():
        variants = [("ssh", 1, 0), ("legacy", 6, 0)]
        variants += [
            (codec, level, size)
            for codec in ("zstd-frame", "zstd-stream")
            for level in (1, 3, 6, 9, 15, 19)
            for size in (0, 8192, 32768)
        ]
        for repetition in range(args.repeats):
            for codec, level, size in variants:
                jobs.append((test, family, repetition, codec, level, size))
    random.Random(20261108).shuffle(jobs)
    with (args.out / "results.jsonl").open("w") as output:
        for index, (test, family, repetition, codec, level, size) in enumerate(jobs):
            dictionary = args.out / f"{family}-{size}.dict" if size else "-"
            result = run(
                [
                    args.binary,
                    args.out / f"{test}.corpus",
                    codec,
                    level,
                    dictionary,
                    args.target_ms,
                ]
            )
            result.update(
                dataset=test,
                dictionary_family=family if size else None,
                dictionary_capacity=size,
                dictionary_bytes=(
                    manifest["dictionaries"][f"{family}-{size}"]["dictionary_bytes"]
                    if size
                    else 0
                ),
                repetition=repetition,
            )
            output.write(json.dumps(result) + "\n")
            output.flush()
            if (index + 1) % 40 == 0:
                print(
                    f"{index + 1}/{len(jobs)} codec trials; all byte-exact", flush=True
                )
    summarize(args.out)


if __name__ == "__main__":
    main()
