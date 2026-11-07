# Bandwidth efficiency against stock Herdr

**Corgi uses about 19% less total traffic for dense output, but 3.23× as much for sparse output.** The latter remains an efficiency problem; the throughput change does not solve it. Both comparisons use 1 Mbit/s, 120 ms RTT and a 20 Hz producer. Sparse delivery is 20 updates/s for both, with almost identical p95 screen age. Dense delivery is 19.97 versus 20.00 updates/s.

Traffic includes both directions of the selected machine’s interface, including SSH, TCP acknowledgements and control messages. All numbers are medians of three independent trials.

| Output | Product | Down kbit/s | Up kbit/s | Total kbit/s | Wire bytes/update | Updates/s | p95 age, s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dense | Corgi before | 452.4 | 34.6 | 486.9 | 4358 | 13.97 | 0.190 |
| dense | Corgi after | 655.2 | 53.5 | 708.7 | 4431 | 19.97 | 0.154 |
| dense | Herdr | 843.7 | 29.5 | 873.2 | 5457 | 20.00 | 0.107 |
| sparse | Corgi before | 211.4 | 45.0 | 256.4 | 1603 | 20.00 | 0.123 |
| sparse | Corgi after | 211.3 | 45.1 | 256.5 | 1603 | 20.00 | 0.097 |
| sparse | Herdr | 73.7 | 5.7 | 79.4 | 496 | 20.00 | 0.098 |

The baseline’s lower dense traffic accompanies its lower frame rate. Use amortized bytes/update, rather than total traffic alone, to interpret the before/after change. This is a rate-normalized link cost, not the serialized size of one frame. Total-rate medians and the medians of each direction need not sum exactly.

[Dense trial data and ranges](stream-120/evidence/summary.json) · [Sparse trial data and ranges](bandwidth/evidence/summary.json) · [Sparse CSV](bandwidth/evidence/trials.csv). Both unlimited and 1 Mbit/s sparse controls are retained; they show the same gap.

The follow-up [byte-level diagnosis](../wire-efficiency/report.md) now captures both unchanged binaries: neither sends full surfaces during steady sparse output. Corgi repeats whole changed rows and substantial metadata, plus receipt RPCs; Herdr sends native binary changed-cell spans. It also verifies that the host's patched SSH compressor does not deduplicate repeated strings. An offline lossless experiment removes 65% of Corgi's compressed downstream payload; this is not yet a production wire-rate improvement. [Exact breakdown and implementation scope](../wire-efficiency/analysis.md).

On constrained links, bandwidth alone is not a quality score. At dense 64 kbit/s, both saturate the downstream cap, but Corgi’s p95 displayed age is 1.54 seconds and Herdr’s is 30.86 seconds. Herdr’s sparse 64 kbit/s stream shows more updates while remaining about 7.15 seconds behind, versus Corgi’s 0.60 seconds. [All throughput, lag and catch-up measurements](measurements.md).

[Reproduce](README.md#additional-bandwidth-and-sleeping-client-comparisons) · [Audit](bandwidth/evidence/audit.json).
