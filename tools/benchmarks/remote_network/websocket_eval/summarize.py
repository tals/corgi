#!/usr/bin/env python3
import argparse, collections, gzip, json, pathlib, statistics

p = argparse.ArgumentParser()
p.add_argument("directories", nargs="+", type=pathlib.Path)
p.add_argument("--output", type=pathlib.Path, required=True)
a = p.parse_args()
rows = []
for directory in a.directories:
    source = directory / "trials.json"
    rows += json.loads(
        source.read_text()
        if source.exists()
        else gzip.decompress((directory / "trials.json.gz").read_bytes())
    )
groups = collections.defaultdict(list)
for r in rows:
    groups[(r["scenario"], r["config"]["corpus"], r["config"]["mode"])].append(r)


def sizes(row, key):
    return sum(s[d][key] for s in row["wire"]["sessions"] for d in ["up", "down"])


def metric(row):
    s, c = row["server"], row["client"]
    return dict(
        socket_bytes=sizes(row, "socket_bytes"),
        data_bytes=sizes(row, "application_phase_bytes"),
        handshake_bytes=sizes(row, "handshake_bytes"),
        down_data_bytes=sum(
            v["down"]["application_phase_bytes"] for v in row["wire"]["sessions"]
        ),
        down_payload_bytes=sum(
            v["down"]["websocket_payload_bytes"] for v in row["wire"]["sessions"]
        ),
        up_data_bytes=sum(
            v["up"]["application_phase_bytes"] for v in row["wire"]["sessions"]
        ),
        total_cpu_us_per_message=(s["cpu_us"] + c["cpu_us"]) / s["messages"],
        server_cpu_us_per_message=s["cpu_us"] / s["messages"],
        client_cpu_us_per_message=c["cpu_us"] / s["messages"],
        duration_ms=s["duration_ms"],
        messages_per_second=s["messages"] / s["duration_ms"] * 1000,
        rtt_p50_ms=s["roundtrip_ms"]["p50"],
        rtt_p95_ms=s["roundtrip_ms"]["p95"],
        delivery_p95_ms=s["delivery_ms"]["p95"],
        connect_ms=c["connect_ms"][0],
        first_message_ms=c["first_message_ms"][0],
        reconnect_first_ms=c["reconnect_first_ms"] or 0,
        endpoint_max_queue=max(s["max_queue_bytes"], c["max_queue_bytes"]),
        proxy_max_queue=row["wire"]["max_queue_bytes"],
        freeze_bytes=row["wire"]["freeze_bytes"],
    )


summary = []
for (scenario, corpus, mode), values in sorted(groups.items()):
    metrics = [metric(r) for r in values]
    summary.append(
        dict(
            scenario=scenario,
            corpus=corpus,
            mode=mode,
            trials=len(values),
            messages=values[0]["server"]["messages"],
            raw_bytes=values[0]["server"]["raw_bytes"],
            metrics={
                k: dict(
                    median=statistics.median(m[k] for m in metrics),
                    min=min(m[k] for m in metrics),
                    max=max(m[k] for m in metrics),
                )
                for k in metrics[0]
            },
        )
    )
a.output.parent.mkdir(parents=True, exist_ok=True)
a.output.write_text(json.dumps(summary, indent=2) + "\n")
print(
    "| Scenario / input | Mode | Down bytes | Both-direction bytes | CPU µs/message | Receipt P95 ms | First content ms |"
)
print("|---|---|---:|---:|---:|---:|---:|")
for r in summary:
    m = {k: v["median"] for k, v in r["metrics"].items()}
    print(
        f"| {r['scenario']} / {r['corpus']} | {r['mode']} | {m['down_data_bytes']:.0f} | {m['data_bytes']:.0f} | {m['total_cpu_us_per_message']:.1f} | {m['rtt_p95_ms']:.2f} | {m['first_message_ms']:.2f} |"
    )
