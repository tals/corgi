# Reproduce live-history compression over real SSH

Read the [comparison](report.md), [measurements](measurements.md), and machine-readable
[summary](evidence/main/summary.json). This is a transport experiment around
unchanged application binaries. It does not install compression in Corgi or patch
Herdr.

## What is compared

| Arm | Application | External adapter | SSH compression |
| --- | --- | --- | --- |
| Corgi stock | Throughput candidate, application revision `9eff77f4` | None | Product default, enabled |
| Corgi zstd | Same binary | Bun live zstd level 3, no dictionary | Disabled |
| Herdr stock | Official v0.9.5 binary | None | Product default, enabled |
| Herdr zstd | Same binary | Identical Bun live zstd level 3, no dictionary | Disabled |
| Identity controls | Same two binaries | Same process/pipes, pass-through codec | Enabled |

Both directions get separate continuous zstd contexts. The adapter flushes after
each natural input chunk, without intentional batching. Every new bridge gets
new contexts. Application message boundaries, receipts, frame budgets, reconnect
policies and row/cell encodings remain the products' own. The private lab SSH
wrapper removes Corgi's `-C` as well as specifying `Compression=no`; otherwise
that flag can re-enable SSH compression. Diagnostic pilots verified negotiated
compression `none` in both directions. Main timing trials have SSH tracing off.
[Adapter](../../codec_bridge.ts), [lab runner](../../codec_run.py),
[negotiation evidence](evidence/ssh-negotiation.txt).

**The primary Herdr baseline is its normal happy path today: stock Herdr plus
the installed SSH client's `-C` compression.** A separate diagnostic run, with
no adapter or compression override, negotiated `zlib@openssh.com` in both
directions. The measured stock process arguments also retain Herdr's own `-C`.
The Herdr zstd arm is an additional control, not a replacement for that baseline.

The selected stream traverses the real remote daemon, bridge, SSH, simulated
network, receiving daemon and viewer. Ghostty decodes the actual viewer output.
This measures end-to-end behavior, including the extra adapter processes and
pipes. It is not a performance guarantee for future in-process integration.
Those pipes add buffering and can affect backpressure and retry timing. The
identity controls isolate their effect at 1 Mbit/s; they do not establish zero
adapter overhead under every constrained-link scenario.

## Prerequisites and binaries

Use the [original network playbook](../../README.md) for Linux network namespace,
sudo, OpenSSH, `iproute2`, Bun and native terminal observer setup. No host link,
route, firewall or application session is modified. Each trial creates private
namespaces, homes, SSH configuration and throwaway keys, then removes them.

Use the [throughput build instructions](../../throughput/README.md#builds) and
[exact build manifests](../../throughput/evidence/builds.json). The measured Corgi
binary SHA-256 is
`59bf1ccecaf400f812ac3f7d81d3cc13fcfedc8ca25328c1cd76a4cb345583fe`;
Herdr's is
`14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`.
The working checkout's HEAD in a lab manifest identifies the harness checkout;
the build manifest identifies the application source. They are different.
This run used Bun 1.4.4 and installed Ubuntu OpenSSH 9.6p1-3ubuntu13.20.

## Run

From the repository root, on a host with the available CPU sets:

```sh
python3 tools/benchmarks/remote_network/codec_matrix.py \
  /path/to/corgi-throughput-after /path/to/herdr-v0.9.5 \
  /tmp/zstd-network --repeats 3

python3 tools/benchmarks/remote_network/codec_matrix.py \
  /path/to/corgi-throughput-after /path/to/herdr-v0.9.5 \
  /tmp/zstd-fast --repeats 3 --suites stream-20 --cpu-start 0
```

The main matrix runs seven suites concurrently, reserving 16 CPUs per suite
starting at CPU 16. Each arm uses four CPUs; arms rotate through those sets in
each of three independent lab repetitions. Identity controls have only two arms.
The measured host has 128 physical cores and 256 logical CPUs. The supplemental
20 ms suite ran concurrently on disjoint CPUs 0–15 under the same benchmark lock.
There were no application builds or test suites during timed trials.

For a smaller host, run one suite at a time with `--suites stream-120
--cpu-start 0` (16 CPUs), or run individual arms serially on an available CPU set:

```sh
python3 tools/benchmarks/remote_network/codec_run.py corgi \
  /path/to/corgi-throughput-after /tmp/corgi-zstd-one \
  --codec zstd --cpus 0-3 --suite stream \
  --stream-cases sparse:1mbit,dense:1mbit,dense:64kbit
```

Use `--codec stock` for the product default and `identity` for the pass-through
control; change the product and binary to test Herdr. Use `--suite faults
--fault-kind dense --fault-cases blackhole3,blackhole35` for outages, or
`--suite sleep --sleep-seconds 180` for client freeze. `--trace-ssh` is a diagnostic
option; exclude such runs from timing comparisons. Never share CPU sets between
simultaneous measured arms.

## Scenarios and interpretation

Each lab has a client and two remote machines, with four live terminal producers
per machine. The selected remote PTY is 132 × 47 in both products. Sparse output
changes progress, sequence and receipt rows; dense output replaces 22 × 108
pseudorandom ASCII characters. Sources run at 20 Hz, so 20 observed updates/s is
the source ceiling, not maximum transport throughput. This is synthetic terminal
traffic; the earlier Claude/Codex codec corpora are not end-to-end network tests.

Streams are measured for 30 seconds after four seconds of settling. The screen's
age is sampled every 50 ms, including periods when it freezes. Input delivery is
checked against independent producer receipts as well as visible echoes. Catch-up
after removing a cap requires a complete new screen at most 500 ms old. The RTT
300 ms and 20 ms stream cases change an established 120 ms path; cold connection
startup at each RTT is measured separately.

Bandwidth figures are bytes observed on the selected machine's virtual Ethernet
link, including both directions, SSH framing, TCP headers, ACKs and retransmits;
they exclude physical Ethernet preamble/FCS/inter-frame gaps. Caps apply **per
direction**, so total traffic can exceed a 64 kbit/s cap. Downstream and upstream
are also retained separately. The other remote's link is not included.

Packet blackholes affect only the selected remote. A separate isolation case
checks local and other-remote input during that blackhole. The three-minute sleep
case first queues an input while downstream ACKs are blocked, stops client-namespace
processes, cuts both links and kills old server-side TCP connections before resuming.
It is a controlled freeze/reconnect simulation, not a physical laptop suspend or
a general wake-up timing claim. Remote producers continue running. The
[follow-up audit](../../latency-and-freeze/README.md) varies the pending write,
TCP destruction and reuse of the old client SSH master independently.

Recovery time starts when the link is restored. “Fresh” means a new complete
screen; “usable” additionally requires a unique input echo. Startup excludes
application installation and daemon boot; it includes the viewer's terminal
capability timeout because the observer does not answer those queries. Three
trials establish observed medians/ranges, not statistical equivalence or Internet
tail probabilities. Retry timing is fixed rather than randomized.

## Reduce and audit

```sh
python3 tools/benchmarks/remote_network/codec_report.py \
  /tmp/zstd-network /tmp/zstd-report/main
python3 tools/benchmarks/remote_network/codec_report.py \
  /tmp/zstd-fast /tmp/zstd-report/fast
```

The reducer writes medians/ranges, per-trial records, CSV and an audit. It checks
scheduled trial/case counts, binary and harness hashes, CPU rotation, codec
configuration, selected PTY dimensions, producer counts, fault durations and
namespace cleanup. It retains unsuccessful input observations and recovery
failures. Expected broken-pipe/premature-close errors when a transport is killed
are distinct from unexpected codec errors. Input receipts and producer continuity
are retained for independent inspection.

The [raw archive](../../../../../dist/remote-zstd-e2e-20261108.tar.gz) preserves
results, viewer observations, resource samples, per-connection codec counters,
network snapshots, application logs and the exact measured harness sources.
It contains no SSH private keys. [Artifact manifest](evidence/artifacts.json).
The archive also includes the reducer; raw paths in JSON identify this workspace's
original trial directories and can be remapped after extraction.

Validation: 90 completed labs, 324 measured scenario results, 4,988 audit checks,
all 780 stream inputs independently received once, and no unexpected codec
errors or recovery timeouts. All 3,375 unit tests passed (one opt-in skip), along
with repository typecheck/format, strict adapter typecheck and Python compilation.
[Validation record](evidence/validation.json). The archive also retains
`dist/render-zstd-e2e-report.py`, which regenerates the Markdown tables from the
two reduced summaries.
