# Reproduce the freeze audit

See the [short report](report.md) and [source/research analysis](analysis.md).
The adaptive-window recommendation is not implemented. This playbook reproduces
the Herdr diagnosis using unmodified v0.9.5 and installed SSH compression.

Use the [network prerequisites](../README.md): Linux namespaces, sudo, OpenSSH,
iproute2, tcpdump, Bun and the built native terminal observer. The measured Herdr
SHA-256 is `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`.
[Source identity](evidence/source.json). No application patch is required.

Create a manifest for your binary, or use the existing stock-Herdr manifest from
the [compression comparison](../compression/end-to-end/README.md):

```sh
python3 tools/benchmarks/remote_network/codec_run.py herdr \
  /path/to/herdr-v0.9.5 /tmp/herdr-baseline \
  --codec stock --suite startup --rtts 120 --cpus 0-3

python3 tools/benchmarks/remote_network/freeze_audit.py /tmp/herdr-freeze-audit \
  --template /tmp/herdr-baseline/manifest.json

python3 tools/benchmarks/remote_network/freeze_report.py \
  /tmp/herdr-freeze-audit /tmp/herdr-freeze-evidence
```

The matrix runs twelve independent labs concurrently on disjoint four-CPU sets
32–79, rotating the four conditions across each repetition's set. It holds the
shared benchmark lock. On a smaller host, run cases individually with `--case
original`, `fresh-ssh-at-wake`, `no-pending-input`, or `transport-survives`, plus an
available `--cpus 0-3`. Use a new output path for each repetition. Individual
`results.json` files remain readable without the matrix reducer.

All cases run sparse output at 20 Hz, selected PTY 132 × 47, two remote machines,
four producers per machine, 120 ms RTT and an actual 180 s freeze. The original
case sends an input while downstream ACKs are dropped, freezes client application
processes, cuts both links, kills old server TCP connections, then restores the
network and resumes. Each control changes only its named condition. The fresh-SSH
control kills old client SSH processes at wake; it does not restart Herdr. The
transport-survives case merely omits forced server TCP destruction and leaves
Herdr's own watchdog/reconnect behavior enabled.

SSH invocation arguments/start times, verbose SSH logs, TCP states, packet headers,
viewer observations, process resources and independent input receipts are
retained. Tracing tools remain running while application processes are stopped.
These instrumented trials diagnose the earlier untraced result; their medians
are not pooled with the old timing trials. Trace timing and TCP retry phase can
affect the outcome; the 13–47 s original-case range is deliberately retained.

The auxiliary watcher `dist/watch-herdr-freeze-fds.py` in the archive samples
process FDs and thread wait states in original-1, without reading application
memory or pipe contents. Start it before wake. The archived
`dist/derive-freeze-timeline.py` derives the checked-in pipe-ownership proof and
packet excerpt from that exact trace (its PIDs/port are specific to the retained
run). For another run, identify its bootstrap PID and local TCP port from
`ssh-debug/starts.jsonl`, `fd-watch.jsonl` and `tcp.jsonl`.

A diagnostic pilot was excluded in full: adding root-owned `ss` probes caused
the initial freeze helper to try to stop an instrumentation process. Two trials
failed, the others were cancelled, and all 48 pilot namespaces were removed.
The corrected helper excludes tracing processes. The original untraced benchmark
did not include those instrumentation processes. The archive preserves the pilot
exclusion and original helper source; no pilot timing enters the report.

The final audit checks all twelve trials, unchanged binary and common harness
hashes, negotiated SSH compression, zero kernel packet-capture drops, freeze
duration, eight remote producer PIDs with advancing CPU counters, input receipts
and namespace cleanup. [Audit](evidence/audit.json),
[validation](evidence/validation.json),
[raw archive](../../../../dist/herdr-freeze-audit-20261108.tar.gz),
[artifact hashes](evidence/artifacts.json).
