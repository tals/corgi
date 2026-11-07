# Sparse bandwidth: byte-level evidence

The [short report](report.md) separates three kinds of evidence: the prior
untraced wire benchmark, new externally traced messages, and offline encoding
experiments. Only the first is a production bandwidth/performance measurement.

## What the wire benchmark establishes

At 1 Mbit/s and 120 ms RTT, median sparse delivery is 20 updates/s for both
products, with p95 displayed age 0.097 s for Corgi and 0.098 s for Herdr.
Corgi uses 256.5 versus 79.4 kbit/s total, or 1,603 versus 496 amortized wire
bytes/update. Downstream is 211.3 versus 73.7 kbit/s; upstream is 45.1 versus
5.7 kbit/s. Approximately 78% of the excess is downstream and 22% upstream.
These rates include SSH, TCP acknowledgements and control traffic, measured at
the selected machine's interface. They are medians of three independent trials.
[Measurements and trial links](../throughput/bandwidth.md).

The throughput fix does not cause this gap: the earlier Corgi build also uses
256.4 kbit/s for sparse output. Dense output is a different result: current
Corgi uses 708.7 versus Herdr's 873.2 kbit/s while delivering 19.97 versus 20.00
updates/s. Do not generalize the sparse 3.23× to all terminal output.

## What actually crosses the application boundary

The diagnostic attaches `strace` to the selected remote machine's native
bridge, after the stream is established. It reassembles stdin reads and stdout
writes, so this is plaintext immediately before/after SSH, without application
instrumentation. Each capture is about 12 seconds at 1 Mbit/s / 120 ms, with
the same 20 Hz workload and 132 × 47 selected PTY. All twelve workload processes
remain alive. Strace may affect scheduling; these runs do not replace the
untraced performance trials. [Capture manifests, byte accounting and checks](evidence/captures.json).

Corgi sends 246 `viewer.frame` messages: 240 patches, each containing exactly
four changed rows, plus six metadata-only frames. **No full surface occurs.**
The four rows contain the header/time marker, the previously active progress
line, the new progress line, and the footer. Every changed row is sent in full,
including 132 columns, padding and ANSI color/reset sequences.
[One complete captured frame](evidence/corgi-sparse-sample.json).

The additive accounting for Corgi's 395,150 render-message bytes is:

| Component | Raw bytes | Share |
| --- | ---: | ---: |
| Changed row strings | 172,800 | 43.7% |
| Row indices and array/object syntax | 18,046 | 4.6% |
| Patch metadata and syntax | 127,680 | 32.3% |
| Frame envelope and view metadata | 76,624 | 19.4% |

Within the row strings: 46,560 bytes are non-padding ASCII text, 80,160 are
trailing spaces, 34,560 are ANSI sequences, and 11,520 are JSON escaping/quotes.
Not all metadata is redundant: base/revision stamps and input receipts carry
correctness information. The experiment below removes only unchanged values,
retaining their meaning at the receiver. [Exact accounting](evidence/corgi-sparse-replay.json).

There are also 265 upstream `viewer.receipt` RPCs, 114 bytes each, and 265
downstream replies, 43 bytes each: **41,605 raw bytes** outside the render
messages. Herdr sends no upstream application messages during its idle-input
capture. This does not mean it sends no TCP ACKs, or that all of Corgi's upstream
wire bytes are receipt JSON. The earlier three-trial benchmark includes input
probes; the diagnostic deliberately has no input probes in its capture window.

Source agrees with the capture: [surface.difference](../../../../src/pane/surface.ts)
compares rows and spreads the complete new view into every patch;
[Frames.offer](../../../../src/viewer_stream.ts) carries the view envelope;
[machine_stream](../../../../src/machine_stream.ts) acknowledges received
frames and sends periodic receipts. [peer](../../../../src/peer.ts) serializes
the JSON reply envelope.

Stock Herdr sends 240 native binary `PaneSurfacePatch` messages: 229,993 bytes
including four-byte length prefixes, 28,965 changed cells, and no full surface.
That averages 120.7 cells per update, versus Corgi's four complete rows / 528
columns. The [captured example](evidence/herdr-sparse-sample.json) includes both
the original binary payload and decoded spans. Its
[span producer](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/headless/retained_surface.rs#L45)
and [bincode framing](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/protocol/wire.rs#L1646)
match the bytes. This corrects the earlier source-based lead: the observed path
uses native `PaneSurfacePatch`, **not** the optional base64-wrapped surface-delta
extension. The independent parser decodes the row/cell section and preserves
the remaining metadata bytes; it is not a complete Herdr protocol implementation.

## Why SSH does not remove the repetition

Both products negotiate `zlib@openssh.com` and enable compression:
[Corgi negotiation](evidence/corgi-sparse-ssh.txt),
[Herdr negotiation](evidence/herdr-sparse-ssh.txt).
Installed client and server are Ubuntu `1:9.6p1-3ubuntu13.20`.
That security update disables LZ77 dictionary coding; compression uses
`Z_HUFFMAN_ONLY`. Huffman coding makes frequent bytes cheaper but does not
replace repeated strings with references.
[Upstream change](https://github.com/openssh/openssh-portable/commit/1d5340fce24526719e32aebc4c721fc228182ace),
[Ubuntu fixed-version advisory](https://ubuntu.com/security/CVE-2026-106582),
[installed changelog](evidence/openssh-changelog.txt).

This is verified against the installed executables, not inferred from a version
string: both [ssh](evidence/ssh-compression-call.txt) and
[sshd](evidence/sshd-compression-call.txt) pass strategy `2` (`Z_HUFFMAN_ONLY`)
in `r9d` to `deflateInit2_`, with level 1 in `esi`.
[Versions and executable hashes](evidence/openssh.json).

Applying that compression strategy to the captured downstream application
messages, with a flush after each message, gives:

| Sparse capture | Raw bytes | Huffman-only bytes | Retained fraction |
| --- | ---: | ---: | ---: |
| Corgi, including receipt replies | 406,545 | 261,807 | 64.4% |
| Herdr | 229,993 | 85,758 | 37.3% |

Corgi sends 1.77× the raw downstream bytes and this representation compresses
less effectively, producing **3.05× the compressed payload**. This is consistent
with the separately measured 2.87× downstream wire ratio; it is not an exact
packet-level model. SSH channel headers, packet boundaries, padding, TCP and
other traffic are excluded. Upstream receipt traffic supplies an additional
mechanism for the larger total-wire gap. [Replay accounting](evidence/captures.json).

As a diagnostic counterfactual, the same Corgi downstream bytes become 19,903
bytes with dictionary-based zlib instead of 261,807 with Huffman-only. This
explains why assuming that SSH will deduplicate verbose messages is misleading
on this host. It is **not** a recommendation to restore the old compression
behavior; the upstream change addresses a cross-channel information leak.

## A small encoding experiment, not a production fix

[wire_compact.py](../wire_compact.py) independently encodes and decodes every
captured Corgi message. It first tries reusing unchanged view/pane metadata,
then replacing a row's changed middle between common prefix and suffix, then
both. Unseen rows are sent in full; a splice is used only when its JSON is
smaller. No messages or receipts are dropped. Comparison uses Python's exact
integers, retaining the protocol's 64-bit identities and hashes.

| Downstream compressed application bytes | Sparse | Dense |
| --- | ---: | ---: |
| Original | 261,807 | 906,700 |
| Reuse metadata | 146,986 (−43.9%) | 788,824 (−13.0%) |
| Row splices alone | 193,396 (−26.1%) | 695,388 (−23.3%) |
| Both | 90,614 (−65.4%) | 588,490 (−35.1%) |

Each variant reconstructs all **776 original messages / 246 frames** in each
workload, with equality assertions and matching canonical semantic SHA-256
hashes. The dense capture contains 240 patches of 24 rows and zero full surfaces.
[Sparse results](evidence/corgi-sparse-replay.json) · [Dense results](evidence/corgi-dense-replay.json).
Upstream payload is unchanged. This proves redundancy can be removed without
losing these messages' information. It does not establish CPU cost, universal
compression ratios, wire savings, or recovery/backpressure behavior of a future
implementation.

A practical follow-up can retain JSON and the current transport:

1. Add a negotiated compact-patch capability, with existing format fallback.
2. Reuse metadata against an explicit accepted frame/base; send fresh state on
   attach, reconnect, resize or surface identity change. Keep revision and
   input-receipt checks. Never advance the base for a frame rejected by the
   bounded sender.
3. Add row splices with defined byte/code-unit semantics, length/bounds checks,
   and full-row fallback. Reconstruct the exact ANSI string before rendering;
   test emoji, wide/combining text, styling and images, not just this ASCII load.
4. Retain receipts and the three-frame bound initially. Compact receipt
   envelopes separately if useful; simply removing acknowledgements would
   compromise the mechanism that bounds stale output.
5. Repeat the matched sparse/dense bandwidth and recovery matrix, including
   64 kbit/s backpressure, outages, reconnect and three-minute client freeze.

This is a contained protocol change rather than a transport rewrite, but the
offline codec intentionally does not implement negotiation, full snapshots or
reset semantics. Production sources and Herdr remain untouched in this commit.

## Validation and retained artifacts

All captured successful stdin/stdout bytes are accounted for, with no partial
messages; all producers survived and private network namespaces were removed.
The external capture, reducers and replay are reproducible from the
[playbook](README.md). [Raw archive and hashes](evidence/artifacts.json) retain
the original syscall traces, manifests and debug logs. Full Corgi unit suite:
3,375 pass, one skip, zero failures; typecheck passes.
[Validation record](evidence/checks.json).
