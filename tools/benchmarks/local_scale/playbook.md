# Reproduce local daemon CPU and socket traffic

This uses the production binary, real daemon/viewer processes, real PTYs, and
the repository's simulated Claude/Codex providers. It makes no model calls and
uses a private home, provider accounts, and socket for every run. Application
code is unchanged. Linux, Bun, `taskset`, `ss`, and sudo access to `bpftrace` are
required.

Run from the repository root. Finish builds/tests before measuring:

```sh
bun build.ts --no-native
bun typecheck.ts
bun test ./src

python3 tools/benchmarks/cost_placement.py /tmp/local-scale-placement.json --seconds 30
taskset -c 0 python3 tools/benchmarks/local_scale/calibrate.py dist/local-scale-calibration-new
python3 tools/benchmarks/local_scale/matrix.py dist/local-scale-new \
  --placement /tmp/local-scale-placement.json
```

Use fresh output paths. The matrix runs serially under the existing benchmark
lock. Defaults are three trials each at 4, 8, and 32 agents, 20-second measured
windows, and five seconds of warmup per window. Agent-count and workload order
rotate between trials. Setup and workload changes occur outside CPU windows.
The selected placement must contain eight distinct physical cores with quiet
SMT siblings; the existing placement tool checks the host before launching Corgi.
This particular runner uses observer CPU 0; change `--observer` on the individual
runner if CPU 0 is unavailable. Matrix execution takes roughly half an hour.

For a short correctness check, excluded from benchmark results:

```sh
taskset -c 0 bun tools/benchmarks/local_scale/run.ts \
  --out dist/local-scale-check --agents 32 --seconds 3 --warmup 5 \
  --cpus 104,105,106,107,108,109,110,111
```

Replace those CPUs with the placement tool's selection. `--binary` accepts an
alternate production binary with a matching `.build.json`. `--counts`,
`--scenarios`, `--attachments`, `--seconds`, `--warmup`, and `--repeats` on
`matrix.py` can narrow a run. `--trace off` disables kernel byte counting for CPU
controls. By default, each 32-agent attached spammy trial includes an adjacent
untraced CPU control; their order alternates between repetitions.

## Workload

Each runtime owns N alternating Claude/Codex providers, one per tab in one
non-Git workspace, plus the initial quiet shell. A single 160×48 viewer shows one 132×47 pane; all hidden
provider PTYs retain that same size. Default animation and resource monitoring
remain enabled.

| Mix | Idle | Light | Spammy |
| --- | ---: | ---: | ---: |
| Idle | 100% | 0% | 0% |
| Mixed | 50% | 25% | 25% |
| Spammy | 0% | 0% | 100% |

Idle agents emit no terminal output. Light agents replace one row at 2 Hz
(about 268 bytes/s each). Spammy agents append 16 colored, roughly 125-character
lines at 20 Hz (42,880 bytes/s each, 320 lines/s). Timers share a monotonic epoch
and stagger their phases across agents. A producer skips missed deadlines
instead of sending a catch-up burst. Each write is timestamped in memory;
receipts are saved only after measurement. Every active producer must stay
within 2% of its requested cadence (with a two-write boundary tolerance).

Attached mixed runs first show a spammy tab, then an idle tab while the same
background agents continue. Detached runs exit the viewer completely. No CLI
polls, navigation, hook transitions, or transcript writes are deliberately
injected into the measured windows. The ordinary fixture hooks still establish
real agent identities and working/idle states before measurement.

This characterizes terminal traffic and Corgi's recurring management work.
Fixtures have minimal transcripts and isolated non-Git projects. They do not
exercise inference, realistic growing conversation histories, bound Codex
app-server polling, repository scanning, multiple viewers, images, or remote
SSH/compression. Providers' own CPU and the harness's terminal emulation are
excluded from Corgi CPU and recorded separately where applicable.

## Measurement and checks

- CPU is the delta of Linux `/proc/PID/stat` user+system counters over the
  window, including every thread in the process. **100% means one logical
  core.** Daemon and viewer are separate; waited-child CPU is also separate
  because Linux can charge it after earlier child work completes.
- The daemon uses the first four selected cores, the viewer the fifth, and
  providers the remaining three. The harness and BPF userspace process use
  CPU 0. Placement, host busy counters, and SMT-sibling load are retained.
  All planned trials are kept; windows over 2% sibling busy are flagged.
  CPU frequency policy is unchanged, so these are host-specific CPU-time
  measurements, not cycle counts or power estimates.
- `socket_bytes.bt` counts successful kernel `unix_stream_sendmsg` return
  values, keyed by process and socket inode, within a monotonic time window.
  This includes actual uncompressed WS frame headers and client masks. No
  traffic proxy, transport patch, telemetry toggle, or payload-size estimate
  is involved. Startup HTTP negotiation falls outside steady-state samples.
- `ss` maps the viewer's socket to its daemon peer. Other daemon Unix sockets
  carry internal worker notifications and are reported separately. Detached
  viewer traffic is zero even if those internal sockets remain active.
- `calibrate.py` checks the kernel counter against exact transfers through an
  independent AF_UNIX socket pair, including small and large writes.
- Producer byte volume, viewer terminal-output bytes, and viewer↔daemon socket
  bytes are distinct measurements. Only the last is called protocol bandwidth.
- Active foreground panes must advance at the expected rate during the CPU
  window. A separate three-second presentation probe checks distinct displayed
  sequences and gaps, then compares the visible sequence with the source pane.
  These checks occur outside the CPU window and do not measure input latency.

Each trial saves `results.json`, exact kernel counters, socket/FD mappings,
producer write receipts, presentation receipts, terminal snapshots as text,
and a cleanup receipt. `plan.json` identifies the executable and harness hashes.
Failed pilots are retained locally and excluded from the reported matrix.
Set `UI_DRIVER_KEEP=1` to retain the stopped fixture home and `server.log` after
cleanup; without it the UI driver removes that home. If a measured trial fails,
preserve the entire attempt before rerunning. The published evidence includes
any such replacement in `continuation.json`; failed partial windows are excluded
as a whole trial, never selected by their CPU or bandwidth values.

To audit and publish a completed full matrix:

```sh
python3 tools/benchmarks/local_scale/audit.py dist/local-scale-new /tmp/local-scale-report/evidence/audit.json
python3 tools/benchmarks/local_scale/publish.py dist/local-scale-new \
  --calibration dist/local-scale-calibration-new --destination /tmp/local-scale-report
```
