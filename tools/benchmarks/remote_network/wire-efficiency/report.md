# Why sparse output costs 3.23× more bandwidth

**There is avoidable repetition, but it is not repeated full-screen redraws.**
The 3.23× gap is the sparse workload: Corgi uses 256.5 versus Herdr's 79.4 kbit/s
at the same 20 updates/s. Dense output already uses 19% less traffic in Corgi.
[Three-trial wire measurements](../throughput/bandwidth.md).

An external capture of the unchanged binaries, after settling, found:

| In ~12 seconds of sparse output | Corgi | Stock Herdr |
| --- | ---: | ---: |
| Content patches / full surfaces | 240 / **0** | 240 / **0** |
| Text sent per content patch | Four entire 132-column rows | ~121 cells in changed spans |
| Raw downstream application bytes | 406,545 | 229,993 |
| Application receipt requests / replies | 265 / 265 | 0 / 0 |

[Audited counts](evidence/captures.json) · [Actual Corgi message](evidence/corgi-sparse-sample.json) · [Actual Herdr message and spans](evidence/herdr-sparse-sample.json).

Corgi repeats pane modes, geometry, identities and view fields: **52% of render
bytes are metadata and framing**. Another 80,160 bytes are trailing spaces in
the changed rows, before counting repeated styling. Receipts add traffic in both
directions. SSH compression is enabled, but this host's security-patched OpenSSH
uses Huffman coding without string deduplication, exposing these costs.
[Byte breakdown and installed-binary proof](analysis.md).

**A contained protocol cleanup looks worthwhile.** A lossless offline prototype
reuses unchanged metadata and replaces only changed portions of row strings:

| Encoding experiment | Sparse payload reduction | Dense payload reduction |
| --- | ---: | ---: |
| Reuse metadata | **43.9%** | **13.0%** |
| Also splice rows | **65.4%** | **35.1%** |

These are compressed downstream application-payload reductions, **not measured
wire savings or a shipped fix**. All 776 messages per workload reconstruct
exactly; receipts are retained. [Sparse replay](evidence/corgi-sparse-replay.json) ·
[Dense replay](evidence/corgi-dense-replay.json).

The follow-up needs capability negotiation, baseline/reset validation, Unicode
coverage and the existing recovery/backpressure matrix. It can retain JSON,
the bounded frame window and current SSH settings. Production Corgi and Herdr
were unchanged in this investigation.

[Detailed proof and implementation scope](analysis.md) · [Reproduction playbook](README.md).
