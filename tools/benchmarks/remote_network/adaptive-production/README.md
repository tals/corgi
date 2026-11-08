# Reproduce the production transport comparison

Build Corgi with `bun build.ts --no-native` (or omit `--no-native` if needed).
The [shared network playbook](../README.md) lists Linux namespaces, sudo, SSH,
Bun, iproute2, ethtool and terminal-observer prerequisites.

```sh
python3 tools/benchmarks/remote_network/adaptive_matrix.py \
  /path/to/corgi-before /path/to/corgi-after /path/to/herdr \
  /tmp/adaptive-comparison
```

The default matrix uses CPU sets 16–171, four logical CPUs per isolated lab. Three
independent repetitions rotate products across each suite's sets. A smaller
machine can select fewer `--suites` or run `adaptive_run.py` cases sequentially
with `--cpus 0-3`; use a fresh output directory for every repetition. No application
code is patched by the harness. Herdr uses its normal installed SSH compression;
new Corgi negotiates its built-in zstd and disables SSH compression on attachments.

```sh
python3 tools/benchmarks/remote_network/adaptive_run.py corgi \
  /path/to/corgi-after /tmp/adaptive-one \
  --suite stream --stream-rtt 300 \
  --stream-cases dense:1mbit,dense:64kbit --cpus 0-3
```

Other suites: `startup`, `navigation`, `faults`, and `sleep`. The default matrix
also includes `cold-ui` (120 ms, a new lab with no prior viewer), `cadence` (60 Hz
sparse/dense at 300 ms and 1 Mbit/s), and `transition` (continuous 1 Mbit/s →
64 kbit/s → 1 Mbit/s, with no settling period omitted around the changes).
These three use `adaptive_extra.py` and can also be run individually. Startup's `--rtts`
defaults to 20,120,300,600 ms. Fault cases include `tcp_reset`, `blackhole3`,
`blackhole35`, `downstream15`, and `isolated30`. Sleep uses a real 180-second
process freeze; `--sleep-control no-pending-input` removes the pre-freeze write.
This is not physical laptop suspend. See the [Herdr freeze audit](../latency-and-freeze/report.md)
for why the pending write matters.

The source produces 20 updates/s in the main scenarios and 60 in `cadence`;
these are source ceilings, not maximum-throughput claims. Each machine has four producers; the selected pane
is 132 × 47 in both applications. Bandwidth caps apply separately per direction.
Traffic counts bytes delivered on the selected machine's virtual link in both
directions, including SSH/TCP overhead; it excludes the other machine's link.

For UI cases only, both applications receive uniquely named tabs through their
normal public commands. The observer records those names from the actual PTY:
`sidebar` is the remote workspace entry, `ui` is its tab strip, and `first_content`
is the first complete matching pane marker, including valid cached content.
Launch-based times include the scripted selection of the remote workspace;
click-based times are retained separately. `remote_seconds` retains the stronger
fresh-content requirement. Navigation measures clicks on three previously hidden
tabs and the return to a cached tab; these are reported separately.

All observations, full UI-transition screens, input receipts, network counters,
process samples, source/binary hashes and cleanup records are retained. Screen
age is sampled over wall time, including freezes, rather than only on arriving
frames. Readiness requires an input echo; failures and lost inputs remain in the
results. Use `--trace` for a separate diagnostic run with Corgi telemetry and TCP
state; do not pool its timings with the untraced trials.

## Reduce and audit

Run from the repository root so relative evidence links resolve consistently:

```sh
python3 tools/benchmarks/remote_network/adaptive_report.py \
  /tmp/adaptive-comparison /tmp/adaptive-reduction
python3 tools/benchmarks/remote_network/adaptive_publish.py \
  /tmp/adaptive-reduction /tmp/adaptive-report
```

The reducer must report 117 labs and zero audit problems for the default matrix.
It checks binary and harness identities, scheduled case counts, independent input
receipts, producer continuity and namespace cleanup. `--partial` is for progress
inspection only. Full distributions retain minima, maxima and missing outcomes.

For a separate instrumented run (never pooled into timing results):

```sh
python3 tools/benchmarks/remote_network/adaptive_diagnostic.py corgi \
  /path/to/corgi-after /tmp/adaptive-diagnostic --cpus 0-3
```

This retains `ssh-debug/*.log`, TCP samples and Corgi telemetry. Herdr can use the
same command with `herdr`; inspect `kex: ... compression:` to confirm the negotiated
SSH codec. The accepted Corgi uses `none`; stock Herdr uses `zlib@openssh.com` on
the installed OpenSSH 9.6p1 build. The diagnostic adds logging overhead, so its
throughput is evidence of mechanism only.

## Build and validation for this result

[Build identities](evidence/builds.json) pins all binaries and source revisions.
[Validation](evidence/validation.json) links the exact logs. Application changes
are captured in the evidence archive's `application.patch`, including newly added
files; apply it to the recorded base commit, install the locked dependencies, then
build normally. No dictionary training or external codec executable is needed.
Bun 1.4.4 supplies the zstd implementation used here.

```sh
bun build.ts --test
bun test src
bun typecheck.ts
CORGI_OLD_EXE=/absolute/path/to/corgi-before \
  bun integration.ts remote reloads reload_compatibility viewers --jobs 1
```

The tests include compression fallback, fragmented streams, corruption, EOF,
delta reconstruction, window bounds, RTT changes and typing across a remote
upgrade. The startup observer does not answer terminal capability probes, so
fallback terminal-probe delays are included equally in both products' launch
measurements. These are synthetic terminal workloads, not live model benchmarks.

The report also includes nine separate edge-case labs (three products × three
repeats) for 600 ms RTT plus 64 kbit/s:

```sh
python3 tools/benchmarks/remote_network/adaptive_matrix.py \
  /path/to/corgi-before /path/to/corgi-after /path/to/herdr \
  /tmp/adaptive-edge --suites stream-600-low --cpu-start 0
python3 tools/benchmarks/remote_network/adaptive_report.py \
  /tmp/adaptive-edge /tmp/adaptive-edge-reduction
```

Pass `--edge /tmp/adaptive-edge-reduction` to `adaptive_publish.py` to include
these in the detailed tables. Run matrices sequentially on a smaller machine;
the shared benchmark lock prevents accidental overlaps by default.
