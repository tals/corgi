# Reproduce the sparse bandwidth diagnosis

Read the [short report](report.md) or [detailed byte attribution](analysis.md).
This is a diagnostic companion to the [untraced benchmark playbook](../throughput/README.md).
It uses unchanged application binaries, real SSH, and external Linux network
namespaces / `tc`; no Corgi or Herdr application hooks are installed.

## Prerequisites and versions

Use the [original harness prerequisites](../README.md): Linux, Python 3, Bun,
the pinned native Corgi build, `ip`, `tc`, OpenSSH, `taskset`, and passwordless
`sudo` for the private lab. Also install `strace`. The analysis scripts use only
Python's standard library. Choose an allowed CPU set with `--cpus` if `32-39`
is unavailable. The capture owns the shared benchmark lock throughout setup,
measurement and cleanup, so run captures sequentially.

The measured Corgi application is `9eff77f4`, with report-only HEAD `580f83f9`
at capture time. Build that application in a worktree using `bun install
--frozen-lockfile` and `bun build.ts`. The report checkout also needs its native
dependencies for the terminal observer. Herdr is the unmodified official
v0.9.5 Linux x64 binary, SHA-256
`14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`.
Inspected Herdr source is `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`.
[Exact captured build manifests](evidence/captures.json).

Both installed SSH packages are `1:9.6p1-3ubuntu13.20`, using Huffman-only
compression after the security update. Record your installed version; an older
dictionary compressor will materially change these results. Do not downgrade
SSH to reproduce the historical compression counterfactual.
[Installed version and binary evidence](evidence/openssh.json).

## Capture and reduce

Run from the report worktree, using fresh output directories:

```sh
python3 tools/benchmarks/remote_network/wire_capture.py \
  /path/to/corgi /tmp/wire-corgi-sparse --kind sparse
python3 tools/benchmarks/remote_network/wire_capture.py \
  /path/to/herdr-v0.9.5 /tmp/wire-herdr-sparse --product herdr --kind sparse
python3 tools/benchmarks/remote_network/wire_capture.py \
  /path/to/corgi /tmp/wire-corgi-dense --kind dense

for run in /tmp/wire-corgi-sparse /tmp/wire-herdr-sparse /tmp/wire-corgi-dense; do
  python3 tools/benchmarks/remote_network/wire_report.py "$run"
done
for run in /tmp/wire-corgi-sparse /tmp/wire-corgi-dense; do
  python3 tools/benchmarks/remote_network/wire_compact.py "$run"
done
python3 tools/benchmarks/remote_network/wire_evidence.py \
  /tmp/wire-corgi-sparse /tmp/wire-herdr-sparse /tmp/wire-corgi-dense \
  /tmp/wire-evidence
```

Each lab runs four producers on each of three machines, then selects Atlas.
The selected PTY is 132 × 47, the producer is 20 Hz, RTT is 120 ms, and the
bandwidth cap is 1 Mbit/s. After settling, a 12-second capture traces the native
bridge's `read(0)` and `write(1)` syscalls. The private lab's SSH wrapper adds
verbose negotiation logging. There are no input probes in the capture window.
`--seconds` changes its duration. Cleanup stops only this lab's processes and
removes its private namespaces.

`wire_report.py` reassembles JSON lines for Corgi and length-prefixed bincode
messages for Herdr. It checks successful syscall byte counts and reports
partial messages. The Herdr decoder is specific to this inspected protocol:
it decodes patch rows/cells, retaining the other payload bytes. Current bridge
threads each own their stdin or stdout direction; the reducer does not support
multiple threads interleaving writes to the same descriptor. Do not treat this
as a general-purpose protocol analyzer.

`wire_compact.py` rejects captures with full surfaces or partial messages: its
prototype covers established streams only. It retains the first observed row
and metadata values, then encodes differences. Every decoded message must equal
the original, and canonical semantic hashes must match across all variants.
Compression uses level 1 / `Z_HUFFMAN_ONLY` and `Z_PARTIAL_FLUSH` after each
message, excluding SSH/TCP framing. The historical dictionary result is an
offline diagnostic only. `wire_evidence.py` checks byte accounting, producers,
PTY size, cleanup, compression negotiation and reconstruction, and exports the
compact evidence files.

## Recheck the archived evidence

The original directories are `dist/remote-wire-original`,
`dist/remote-wire-herdr`, and `dist/remote-wire-dense`. Their
[raw archive](../../../../dist/remote-wire-efficiency-20261107.tar.gz) can be
extracted into an empty directory, then passed to the same reducer commands.
[Archive SHA-256 and per-file hashes](evidence/artifacts.json).
The committed `captures.json` also includes syscall trace and decoded-message
hashes. The archive includes the capture-time harness; current analysis-tool
hashes are in [analysis-tools.json](evidence/analysis-tools.json).

To verify the installed SSH behavior independently:

```sh
dpkg-query -W openssh-client openssh-server
sha256sum /usr/bin/ssh /usr/sbin/sshd
zcat /usr/share/doc/openssh-client/changelog.Debian.gz | head -n 60
objdump -d /usr/bin/ssh | rg -B14 -A3 'call.*<deflateInit2_'
objdump -d /usr/sbin/sshd | rg -B14 -A3 'call.*<deflateInit2_'
```

On this x86-64 build, `r9d = 2` supplies `Z_HUFFMAN_ONLY` and `esi = 1` supplies
the compression level. Different architectures/builds may generate different
assembly. Compare against the
[pinned upstream patch](https://github.com/openssh/openssh-portable/commit/1d5340fce24526719e32aebc4c721fc228182ace).

These single diagnostic captures establish message contents and redundancy,
not a distribution of production performance. For wire rate, displayed lag,
recovery and backpressure, run the [three-trial matrix](../throughput/README.md)
with tracing disabled. A future implementation must repeat those measurements;
the offline payload reductions are not substitutes.
