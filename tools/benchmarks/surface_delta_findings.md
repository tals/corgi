# Row-delta wire prototype

The isolated prototype reduces sparse wire traffic substantially, but removes
tens of microseconds per frame from the measured pipeline. It does not remove
most viewer work. Full scrolling regresses when every row is wrapped as a patch.
This supports a bounded protocol experiment with a full-response fallback; it
does not establish a large whole-application saving or justify native generation
machinery on payload counts alone.

No production protocol, native capture, or viewer code changed for this test.
`surface_delta_costs.ts` uses the production JSON codec, mirror installation,
Controller composition and native Differ. The baseline already installs only
changed native rows. Both methods receive real canonical 132-by-47 surfaces
inside a 160-by-48 UI with sixteen idle pane entries and one visible pane.

## CPU and payload

CPU below is median user plus system microseconds per frame, eight samples per
method and stage across two invocations with reversed balanced order. Stages
were measured separately and must not be added together.

| Case | Codec full → delta | Viewer full → delta | Combined full → delta | Wire bytes/frame full → delta |
| --- | ---: | ---: | ---: | ---: |
| Sparse, one changed row | 58.72 → 21.20 | 158.58 → 143.50 | 188.53 → 151.25 | 10,830 → 854 |
| Cursor only | 57.59 → 16.47 | 115.27 → 85.08 | 129.68 → 87.02 | 10,831 → 631 |
| Scroll, all rows changed | 53.37 → 83.84 | 416.49 → 431.56 | 447.21 → 478.79 | 10,835 → 11,126 |
| Explicit/automatic links | 54.86 → 22.98 | 569.16 → 540.74 | 612.87 → 561.21 | 11,007 → 1,250 |
| Input modes only | 53.49 → 15.80 | 48.75 → 20.69 | 80.00 → 32.41 | 10,832 → 632 |

Codec includes sender comparisons/message construction, JSON stringify, UTF-8
buffer creation, decode/reviver, normalization and reconstruction. Viewer starts
from pre-encoded UTF-8 messages and includes decoding, reconstruction,
`Mirror.receive`, Controller composition, native diff and output-buffer creation.
Combined includes both sender and viewer work. Native feed/capture, RPC metadata,
socket syscalls, timer wakeups, actual stdout and animation are excluded. Image
transfer is verified separately, outside timing.

Sparse combined CPU falls 19.8% in this component measurement, compared with a
92.1% wire reduction. At an assumed twenty updates/second, the pooled 37.3 µs
difference models 0.075 percentage points of one core. That arithmetic is neither
a whole-app measurement nor a rigorous upper bound. In the individual normal and
reverse invocations, sparse medians were 181.9 → 159.9 and 192.9 → 135.9 µs;
allocation, JIT and ordinary GC variation affects the size of the estimate.

All-row patches increase combined CPU 7.1%. Sending a full View when most rows
change should avoid their larger representation and nested-array reviver work,
but that safeguard was not implemented or measured here. The sender's row
comparison itself would still cost something.

The 64-frame ring contains one full resynchronization per cycle, then 63 patches.
Sparse input edits cycle across three distinct rows, one per update. The delta
decoder handles 110 row strings per cycle versus 3,008 in the full case, while
copying 2,961 row references into new arrays. The sender retains approximately
9.6 KB of canonical row UTF-8 payload per client, plus object/array overhead.
These are workload and retention proxies, not measured allocations, live heap,
RSS or GC costs. No forced collection was used; collections can cross trial
boundaries.

This Bun prototype compares row strings for equality. Native row generations
would initially report reformatted rows, potentially including unchanged ones.
In particular, link-related invalidation can conservatively reformat all rows
even though this prototype transmits only two. Its payload savings therefore
must not be assigned automatically to a native dirty-row protocol. Conversely,
native generations could remove some native capture/copy/JSON work excluded
here; this experiment does not estimate that additional saving.

## Correctness and controls

Focused TypeScript checking passed. Verification passed for 320 representative
frames and fourteen reset/transition frames with exact reconstructed Views,
native styled rows, cursors, links, input modes, image metadata, differential ANSI
and final host surfaces. Eighteen recovery checks cover delayed independent
clients accumulating three-row changes, dropped replies, multiple installations
before presentation, selection holds, malformed indices/duplicates without
partial mutation, and resynchronization. Sixteen additional captures cover two
independent viewports. Four image cases verify actual pixel upload, placement,
held synchronized removal and final removal command bytes.

Resize, replacement identity, shortened wide glyphs, selected captures,
synchronized output and alternate-screen changes are included in the transition
fixtures. The per-client last-sent prototype sends a full response after a
dropped/unapplied message; it does not pretend to implement native accumulated
row generations.

Both timing invocations ran serially on physical CPUs 40–47, NUMA node 0, with
memory bound to node 0. SMT siblings 168–175 had maximum whole-invocation load
0.321% and 0.446%; all 32 observed application clamp snapshots were 1024/1024.
The observer ran on CPU 0. Each fresh fixture warmed 128 frames, then measured
512 frames; four alternating-order trials per invocation gave eight samples.
One initial launcher failure is preserved: `numactl` needed `--all` because its
parent observer had narrowed its own affinity. The benchmark never started in
that attempt. No performance attempt failed the prospective two-percent sibling
guard.

## Provenance

Raw logs, source copies, verification, timing samples, host/clamp observations,
the prospective plan and analysis are in `dist/surface-delta-v16/`. The source
and four native assets matched frozen V16 before and after timing. V16 is an
archived experiment; restoring V15 afterward does not alter these measurements.

- Product source SHA256: `fd115d14af3ccfcda0cec06c3693cb453b64e83f2bf096bc19cb4ec4926f5ccd`
- Four native assets SHA256: `3590ae98a4e01e1c05992c299370c10b04dec891443dcd4da70bad49d4ab410b`
- Terminal DSO SHA256: `a96a2b24e0145b9abdbe91e8a6ec366062946d991f5a25b7d7802543dea90973`
- Timed harness SHA256: `a886308f67fb2d84f5e633726f683a92204ef17c200e700fe8ac95b6fd9c4910`
- Raw manifest SHA256: `227743936c8e0c0fb4a7b12e88fb11a87b084b37123fdfd2e1e6d5ebd82f82be`

The initial focused tsc invocation failed because TypeScript 6 requires
`--ignoreConfig` with explicit files. The corrected invocation passed; no
benchmark code or product fix was needed for correctness.
