# Measurement checks and limits

Each window is 20 seconds after 5 seconds warmup; three trials rotate count/workload order. Host: AMD EPYC 7C13 64-Core Processor, Linux, CPUs `104,105,106,107,108,109,110,111`. These are host-specific workload measurements, not a comparison with Herdr or the previous transport.

† 11 of 66 successful windows exceeded the predeclared 2% SMT-sibling busy flag; all remain included. Ranges and individual flags are in the evidence. Minimal provider transcripts and non-Git projects omit inference, growing conversation histories, bound Codex app-server polling and repository work. Waited-child CPU is recorded separately, not included in daemon CPU, because Linux can charge earlier child work at reap time.

Kernel counters were independently checked against exact AF_UNIX transfers: **8,260,182 bytes in each direction, exact match**. Viewer peers are identified by socket inode; no proxy or application patch is used. The 32-agent spammy case also alternates adjacent traced/untraced CPU windows; those pairs are retained in `tracing_controls` in the summary. Startup/HTTP negotiation is excluded.

In that CPU control, traced daemon/viewer medians were **26.20% / 16.90%**, versus **25.70% / 15.45%** without tracing. Paired differences and trial ranges are in the summary; the main table consistently uses the traced windows.

The largest waited-child charge was **2.30 percentage points** of one core. That delayed accounting is not an exact contemporaneous helper-process total.
