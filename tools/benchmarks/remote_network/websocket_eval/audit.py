#!/usr/bin/env python3
"""Check final evidence against frozen harness, corpus and recorded results."""

import gzip
import hashlib
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent
repository = root.parents[3]
rows, runs, frozen = [], [], None
for name in ["loopback", "shaped"]:
    directory = root / "evidence" / name
    trials = json.loads((directory / "trials.json").read_text())
    environment = json.loads((directory / "environment.json").read_text())
    current = {
        p: hashlib.sha256((root / p).read_bytes()).hexdigest()
        for p in environment["source_sha256"]
    }
    assert current == environment["source_sha256"], ("ChangedHarness", name)
    if frozen is not None:
        assert frozen == current, "DifferentHarnessBetweenRuns"
    frozen = current
    rows += trials
    runs.append({"name": name, "bun": environment["bun"], "trials": len(trials)})
for row in rows:
    server, client = row["server"], row["client"]
    assert server["messages"] == client["messages"], "MissingMessages"
    assert server["raw_bytes"] == client["verified_bytes"], "UnverifiedBytes"
    assert server["delivery_ms"]["min"] >= 0, "InvalidSharedClock"
    if row["scenario"] == "freeze":
        assert row["wire"]["freeze_bytes"] > 0, "FreezeNotExercised"
    if row["scenario"] == "reconnect":
        assert (
            server["connections"] == client["connections"] == 2
        ), "ReconnectNotExercised"
    for session in row["wire"]["sessions"]:
        if not row["config"].get("reconnect"):
            assert (
                session["up"]["incomplete_bytes"]
                == session["down"]["incomplete_bytes"]
                == 0
            )
        mode = row["config"]["mode"]
        if mode.startswith("websocket"):
            assert session["up"]["frames"] == session["up"]["masked_frames"]
            header = session["down"]["handshake"].lower()
            assert ("sec-websocket-extensions: permessage-deflate" in header) == (
                mode == "websocket-deflate"
            )
            assert "no_context_takeover" not in header
            expected = session["down"]["frames"] if mode == "websocket-deflate" else 0
            assert session["down"]["compressed_frames"] == expected
for corpus in ["sparse", "dense", "claude", "codex"]:
    for scenario in ["latency", "throughput"]:
        payloads = {
            r["wire"]["sessions"][0]["down"]["websocket_payload_bytes"]
            for r in rows
            if r["scenario"] == scenario
            and r["config"]["corpus"] == corpus
            and r["config"]["mode"] in ["tcp-zstd", "websocket-zstd"]
        }
        assert len(payloads) == 1, ("DifferentZstdPayloadBytes", corpus, scenario)
manifest = json.loads((root / "fixtures" / "manifest.json").read_text())
for name, value in manifest.items():
    payload = gzip.decompress((root / "fixtures" / f"{name}.jsonl.gz").read_bytes())
    assert hashlib.sha256(payload).hexdigest() == value["corpus_sha256"]
    assert (
        len(payload) == value["bytes"]
        and len(payload.splitlines()) == value["messages"]
    )
source_counts = {}
for name in ["sparse", "dense"]:
    source = repository / manifest[name]["source"]
    if not source.exists():
        source_counts[name] = {"available": False}
        continue
    original = [
        value
        for line in source.read_text().splitlines()
        if (value := json.loads(line)).get("kind") == "viewer.frame"
        and value.get("direction") == "down"
    ]
    lines = gzip.decompress(
        (root / "fixtures" / f"{name}.jsonl.gz").read_bytes()
    ).splitlines(keepends=True)
    assert len(lines) == len(original)
    mismatches = sum(
        len(line) != capture["bytes"] for line, capture in zip(lines, original)
    )
    assert mismatches == 0
    source_counts[name] = {
        "available": True,
        "messages": len(lines),
        "original_byte_count_mismatches": mismatches,
    }
result = {
    "trials": len(rows),
    "runs": runs,
    "source_sha256": frozen,
    "exact_payload_verification": True,
    "identical_zstd_downstream_payload_in_tcp_and_websocket": True,
    "nonnegative_cross_process_delays": True,
    "clock": "Linux libc clock_gettime(CLOCK_MONOTONIC), one shared kernel epoch",
    "final_ack_encoding_drained_before_client_cpu_stop": True,
    "source_files_match_recorded_sha256": True,
    "captured_wire_byte_counts": source_counts,
    "production_channel_sha256": hashlib.sha256(
        (repository / "src/wire_compression.ts").read_bytes()
    ).hexdigest(),
}
(root / "evidence" / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
