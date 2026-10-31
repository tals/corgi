# Terminal representation costs

Native baseline: PR #15, `fb129d2ef96511a3c727112e0d1df2191bb5b241`.
The TypeScript wrappers are the investigation worktree with telemetry disabled,
not byte-identical PR #15 source. Experiments are in
[terminal_costs.ts](terminal_costs.ts); production behavior is unchanged by these
prototypes. Source/library SHA-256 hashes and the source diff accompany the raw
measurements under `dist/terminal-costs/`.

The repeated terminal conversions are real and expensive relative to their
compact alternatives. **At one visible 132×47 pane updating 20 times/s, their
combined hot-microbenchmark projection is under one percentage point of one CPU core.**
They do not explain a large whole-application CPU gap by themselves. Larger
screens, multiple visible panes/viewers and higher refresh rates increase the
opportunity. The row-diff alternative also has a serious bandwidth tradeoff.

## Measured stage costs

AMD EPYC 7C13, Bun 1.4.4, CPUs 8–15 and memory bound to NUMA node 0. One
exclusive benchmark slot; no concurrent team benchmarks, tests or builds.
A separate observer on CPU 0 sampled `/proc/stat` for a 20-second window during
the run. The busiest SMT sibling averaged 1.55% busy in that window. This partial
window does not establish complete isolation from other users of the host.

For a 132×47 pane scrolling one approximately 132-byte line per update:

| Stage | Current CPU µs/update | Prototype CPU µs/update | Saved CPU µs/update | Modeled saving at 20 updates/s |
| --- | ---: | ---: | ---: | ---: |
| Daemon export + reserialization → opaque relay | 173.9 | 117.3 | 56.6 | 0.113 CPU percentage points |
| Viewer eager mirror + normal rows → lazy mirror | 181.1 | 4.1 | 177.0 | 0.354 CPU percentage points |
| Host cell diff → row diff | 217.4 | 6.5 | 210.9 | 0.422 CPU percentage points |

100% means one CPU core. These are medians of five trials, not integrated daemon
measurements. The formula is `saved_microseconds × updates_per_second / 10,000`.
The last column assumes exactly one visible pane at 20 Hz and one host frame per
pane update; real UI animation can redraw at another cadence. Export excludes
PTY feeding and dirty render updates, and host diff excludes UI composition.
The three deltas sum to a **0.889-point modeled estimate for this scenario**,
before production integration overhead or fallback frequency. This is not a
rigorous upper bound: production cache behavior, GC, bursts and redraw cadence
can differ from these hot microbenchmarks. It is not a measured whole-app saving.

Within the current viewer receive path, the lower-level native receive/render
stage costs 158.2 µs. Feeding its already assembled ANSI frame and updating the
native render state costs 123.7 µs. Thus eliminating only JSON leaves most of
that stage intact: the full replay/render is substantial. Parsing the original
132-byte program update alone costs 0.37 µs; parsing its wire JSON in Bun costs
26.6 µs. These are nested/mechanical stages, not additional additive totals.

The surface JSON averages 8,910 bytes/update: **67.7×** the source update size.
Across the 32-frame scrolling fixture, the existing cell differ sends 24,138
bytes; the row differ sends 263,920 bytes, **10.9× more**. Similar lines differ
mostly in their counters, so resending whole rows gives up the existing
cell-span savings. A better follow-up is to preserve the cell differ's output
precision while feeding it only known changed screen regions.

The five-trial CPU ranges were 165.3–183.2 µs for current export versus
114.7–128.1 µs for opaque relay, 164.5–187.4 µs for eager mirror versus
3.98–4.12 µs for lazy mirror, and 213.6–229.8 µs for cell diff versus
6.34–6.68 µs for row diff. No claim of sub-microsecond delta precision is intended.

One-character updates expose the dependence on screen area:

| Screen | Cells | Current export µs | Eager receive µs | Cell diff µs | Lazy receive µs | Row diff µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 80×24 | 1,920 | 75.1 | 70.7 | 72.9 | 1.8 | 0.9 |
| 160×48 | 7,680 | 212.5 | 218.6 | 270.0 | 4.0 | 1.7 |
| 320×96 | 30,720 | 718.6 | 769.0 | 1,041.3 | 8.9 | 4.3 |

The six fixed 120×40 real-application screen corpora give these medians:

| Corpus | Export current / opaque µs | Receive eager / lazy µs | Diff cell / row µs | Row / cell output bytes |
| --- | ---: | ---: | ---: | ---: |
| cat | 177.0 / 126.0 | 152.3 / 3.3 | 196.7 / 5.9 | 4.23× |
| cat-dense | 183.8 / 131.6 | 149.1 / 3.1 | 233.8 / 4.6 | 1.46× |
| Claude | 197.8 / 132.7 | 239.2 / 3.8 | 199.9 / 2.9 | 2.20× |
| Codex | 212.0 / 143.9 | 198.7 / 3.9 | 203.5 / 3.0 | 1.91× |
| Micro | 342.8 / 219.1 | 417.9 / 7.1 | 345.0 / 8.0 | 1.85× |
| shell | 172.5 / 128.8 | 210.7 / 3.4 | 182.1 / 1.6 | 1.56× |

All **322 frames** passed equivalence checks. The checks include exact terminal
snapshots, visible cursor, two paste modes, lazy dimming/selection/hyperlink
fallback, and empty diffs for repeated frames. The generated row-diff prototype
does not yet cover full UI composition or image placement.

Raw trials: [node0.json](../../dist/terminal-costs/node0.json),
[derived medians](../../dist/terminal-costs/summary.json),
[host sample](../../dist/terminal-costs/node0-host-sample.json),
[source diff](../../dist/terminal-costs/source.patch). These ignored artifacts
are local to this worktree. Reproduce with:

```sh
CORGI_NATIVE_ROOT=/path/to/baseline/native/zig-out \
  numactl --all --physcpubind=8-15 --membind=0 \
  bun tools/benchmarks/terminal_costs.ts > terminal-costs.json
```

## What happens for one visible pane update

1. The daemon's Ghostty terminal consumes the program's PTY output. This is
   necessary emulation of an external byte protocol.
2. `pane/surface.capture` scans every visible cell and allocates independently
   styled ANSI strings for every row. `app_terminal_json` serializes the result
   to JSON in a temporary arena and copies it into Bun's reply buffer.
3. `native_bridge.call` decodes that buffer into a JS string and parses a JS
   object graph. `Terminal.surface` normalizes its stamp. `Client.queue`
   serializes the object graph back to JSON, encodes a new byte buffer, and
   copies it into its pending output buffer before writing the socket.
4. The viewer's RPC layer decodes and parses the reply. `mirror.Terminal.receive`
   normalizes it and serializes the surface back to JSON for `viewer_receive`.
   Native code parses that JSON, concatenates every row into ANSI, clears its
   separate Ghostty terminal, and replays the complete surface into it.
5. PR #15's normal row path then draws the **original received row strings**.
   It still paid step 4. Only clipping, dimming, hover and selection need the
   transformed native rows. Input encoding and interaction also use the mirror.
6. The viewer constructs a complete ANSI frame, including unchanged pane rows
   on sidebar animation ticks. The native `frame_diff.Differ` parses the complete
   frame into another Ghostty terminal, updates its render state, and hashes all
   screen cells to discover the small output delta sent to the host terminal.

The two extra terminal emulations are representation conversions inside Corgi;
they are distinct from emulating the child program's output. A native handle
already exists for each daemon terminal. Moving arbitrary policy to Zig would
not by itself remove these conversions: the important change is keeping a
representation appropriate to its next consumer.

Source locations: `native/zig/pane/surface.zig` (`capture`, `writeRowHovered`),
`native/app_bridge.zig` (`result`), `src/native_bridge.ts` (`call`),
`src/viewer_protocol.ts` (`sync`), `src/peer.ts` (`queue`), `src/rpc.ts`,
`src/mirror.ts` (`receive`, `rows`), `native/viewer_bridge.zig` (`viewer_receive`),
`src/render.ts` (`frame`), `native/zig/frame_diff.zig` (`diff`, `hashCells`).

## Compact equivalents being measured

| Experiment | Preserved work | Avoided work | Limit |
| --- | --- | --- | --- |
| Opaque JSON relay | Existing native capture and JSON; independent output bytes | Bun parse, object graph, normalization and reserialization in daemon | Surface payload only; real envelope and preview/live mode override still need integration |
| Lazy native mirror | Same received ANSI rows and metadata; existing native fallback on demand | JSON encoding, native JSON parsing and terminal replay on ordinary drawing | Tests dimming, links and selection; full production input/gesture lifecycle remains to integrate |
| Row diff | Exact rendered text, style, links, visible cursor and synchronized output | Whole-frame ANSI parsing, render-state rebuilding and per-cell hashing | Single text pane; complete UI, overlays and Kitty images require an explicit composed-row representation |

The row differ deliberately measures a CPU/bandwidth tradeoff. Sending an entire
changed row can use substantially more bytes than the existing changed-cell
spans. A large CPU win alone is insufficient reason to replace the differ.

The lazy-mirror experiment revisits a concept present in withheld commit
`5092929`, without applying that implementation. Its earlier complexity came
partly from exposing mutable native objects: retaining an `inner` reference
requires eager updates forever. A narrower mirror interface would make the
ownership rule simpler than multiplying cache flags.

## Scaling and data movement

Let `P` be visible panes, `C × R` their average dimensions, `F` their update rate,
and `V` independent viewers. Full-surface export and eager mirror work scale
roughly with `V × P × C × R × F`, not with the number of changed cells. Separate
viewer interests and known stamps suppress unchanged exports, but there is no
cross-viewer surface cache. Background hidden panes still emulate PTY output;
they do not all pass through visible-surface export.

Host-frame parsing and hashing scale with viewer screen area and redraw rate,
including redraws triggered only by sidebar animation. At 160×48 and 13.33
frames/s, the hash loop visits about 102,400 cells/s. This is an operation count,
not measured CPU. The differ retains two `u64` hash arrays: exactly 16 bytes/cell,
or 122,880 bytes at that size, in addition to its terminal and render state.

Each native capture allocates a row-slice array and one output slice per row,
plus JSON and arena storage. JS parsing materializes the row strings and object
graph at each boundary. The benchmark reports serialized byte counts and the
reachable object/string inventory; those are **not total allocator traffic**.
An allocation profile is required to distinguish arena growth, retained capacity,
short-lived JS strings and GC work. RSS or heap-size differences cannot supply
that attribution.

## Measurement contract

The six checked-in PTY-derived frame corpora cover shell, Codex, Claude, editor,
and scrolling text at 120×40. Generated 80×24, 160×48 and 320×96 screens change
one character per update, making the area dependence visible independently of
application output volume. A separate 132×47 fixture scrolls the same short
line shape as the live CPU harness. Tests compare exact terminal snapshots for
every frame, check visible cursor and paste modes, exercise lazy fallback, and
require repeated frames to emit no diff bytes.

All fixtures are prepared outside timing. Export benchmarks use the last screen
with its native render state already current. Receive/diff tests cycle all
frames. Each method warms for 50 ms, then receives five 150 ms trials with order
reversed on alternate passes. Forced GC is outside each trial. CPU time includes
all process threads and any natural collection within timing. Measurements are
stage costs; overlapping stages must not be added together.

The global benchmark lock must be held and CPU/NUMA placement recorded. Initial
downloads, native builds, fixture loading and verification are outside timing.
These are warm stage costs, not startup claims or end-to-end CPU savings.

## Viewer profile follow-up

A separate diagnostic run used the telemetry binary and Bun's CPU profiler with
16 agents and default pane geometry. Its process CPU numbers are not baseline
measurements. The main-thread profile contains 1,459 samples over 50.91 seconds;
the exact eight-second measurement windows contain 65 idle samples and 400
streaming samples. The small idle sample count only supports rough ranking.

[terminal_costs_profile.py](terminal_costs_profile.py) selects samples by the
phase timestamps in `results.json`, then counts each sample once. The profile's
`timeDeltas` include sleep: 896 gaps exceed 10 ms, and the median gap is 16.6 ms.
Weighting frames by those gaps would incorrectly attribute idle time as CPU.
The report records self samples, inclusive samples, and leaf-first stacks:

```sh
python3 tools/benchmarks/terminal_costs_profile.py dist/profile-minimal \
  > dist/profile-minimal/viewer-profile-summary.json
```

| Streaming stack | Inclusive samples | Share of sampled main-thread execution |
| --- | ---: | ---: |
| Controller frame composition | 154 | 38.5% |
| Host presentation | 111 | 27.8% |
| Host differ, within presentation | 102 | 25.5% |
| Sidebar drawing, within composition | 80 | 20.0% |
| Mirror receive | 51 | 12.8% |
| Sidebar cursor-column rewriting, within drawing | 28 | 7.0% |
| Navigation selection reconciliation, across callers | 14 | 3.5% |
| Agent-entry construction, within composition | 13 | 3.3% |

These overlapping shares are not process CPU percentages or measured savings.
The profile does not attribute auxiliary compiler/GC threads. Native work may
also be attributed to its FFI wrapper: the differ wrapper's large self share
does not prove that `Buffer.from` or `Buffer.alloc` dominates the native diff.
In the idle window, composition accounts for 40/65 samples, with cursor-column
rewriting in 15 of them; the host differ has eight samples.

The profile supports three source-level follow-ups:

- `sidebar.ts:shiftColumns` scans the entire rendered sidebar with a regular
  expression, converts each cursor column from text to a number and back, and
  constructs a replacement string. `drawFrame` first builds a separate Writer
  for this purpose. An explicit drawing origin would avoid parsing generated
  terminal commands. This is a good compact-equivalence experiment; it has not
  yet been implemented or timed.
- `navigation.ts:State.entry` reconciles the selection on every accessor.
  `layout.ts:Selection.reconcile` copies the old tab array, copies/maps the model
  tabs, and searches the old array for each tab, even when the model is unchanged.
  Normal composition reaches this through several helpers, and maintenance also
  reaches it through `wakeFocused`. Reconcile at an explicit model-change boundary
  instead of turning a read accessor into repeated allocation and O(tabs²) work.
  Model revisions are updated at boundaries, so a cache needs that ownership
  rule established rather than assuming every model method increments revision.
- `Controller.agentEntries` rebuilds arrays and entry objects each frame, followed
  by `sidebar_rows.update` finding and cloning entries. Sidebar rows then rebuild
  their labels, styles and widths even when only the visible terminal changes.
  Retaining semantic sidebar rows and invalidating them on relevant state changes
  would avoid more work than only optimizing their final string serialization.

Aggregate telemetry agrees that composition is repeated more often than pane
surfaces arrive. In the streaming window there are 160 received surfaces, 208
compositions and 201 presentations. Composition produces 4,658,374 UTF-8 bytes
of complete frames, about 582 KB/s, while the host receives about 24.5 KB/s of
diffs. The idle window still composes 73 complete frames (1,629,463 bytes), though
only 18 reach presentation. These are composed output byte counts, not complete
allocation totals: temporary strings, row arrays and GC traffic remain unmeasured.

Local evidence: [phase-filtered sample summary](../../dist/profile-minimal/viewer-profile-summary.json),
[aggregate telemetry](../../dist/profile-minimal/telemetry-summary.json), and
[phase measurements](../../dist/profile-minimal/results.json).

## Normal recovery snapshots

Normal recovery calls `checkpoint.capture(runtime, false)`, then writes its JSON.
`Screen.capture` obtains `Terminal.snapshot()` and base64-encodes its bytes. This
is different from live handoff: the existing direct FFI `terminal_snapshot`
function calls `liveSnapshot()`, which preserves terminal modes, both screens,
cursor and title. Normal snapshots format unwrapped screen/history content and,
when alternate screen is active, append its contents after primary history.
Substituting the handoff operation would change recovery behavior.

The normal boundary runs the screen formatter into an allocated native buffer,
then serializes it into a JSON envelope in a temporary arena. The pinned Zig
0.16 serializer emits valid UTF-8 byte slices as JSON strings, not number arrays;
invalid UTF-8 has a number-array fallback. It validates UTF-8 and escapes control
bytes before copying the JSON to Bun. Bun decodes it to a string, parses it with
the general BigInt reviver, and re-encodes the snapshot as a Buffer.
`base64.encode` copies that Buffer once more before producing its base64 string.
Checkpoint copying, final JSON serialization and atomic disk writing add other
costs beyond this terminal boundary.

The generic native bridge has one 65,536-byte reply buffer. If a reply exceeds
it, native code has already formatted and serialized the entire result before
returning its required size. Bun then allocates a larger buffer and repeats the
native operation; that larger buffer is discarded after the call. Retaining
capacity can therefore avoid a second formatting/serialization pass for large
snapshots. It offers no such saving when ordinary replies fit the shared buffer.

[terminal_costs_snapshot.ts](terminal_costs_snapshot.ts) isolates the existing
normal snapshot plus checkpoint base64 encoding. Its equivalent alternatives
retain reply capacity, parse the known envelope without a BigInt reviver, and
avoid the extra Buffer copy before base64. Sixteen panes use one 132×47 visible
pane and fifteen 80×24 hidden panes. Input grows from 0 to 64, 512 and 4,096
lines, but retained history is bounded: production configures
`max_scrollback_bytes = 10_000`, with page allocation and pruning determining
the actual retained content. This setting is not a 10,000-byte cap on formatted
snapshot output: the measured snapshots below exceed it. Reported byte counts
establish the output size; input volume is not assumed to equal retained history.

The microbenchmark passed **68 exact-byte/base64 checks**: 64 pane fixtures plus
empty, Unicode/style/link, alternate-screen/input-mode and large colored-screen
cases. The latter is a correctness stress case, excluded from the timing table.
All 68 produced JSON strings; none produced the number-array fallback. Restoring
the alternate-screen case preserves both primary history and alternate content
while leaving the fresh terminal on its primary screen without mouse or paste
modes, matching normal recovery semantics.

| Input lines per pane | Snapshot bytes per pane | Native calls per 16 panes, current → retained | Current CPU ms/save | Retained capacity, same parser | Retained + plain parse + direct base64 | Modeled combined saving at 0.5 saves/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 12–13 | 16 → 16 | 0.066 | 0.069 | 0.061 | 0.0003 CPU points |
| 64 | 8,460–8,461 | 16 → 16 | 0.936 | 0.935 | 0.899 | 0.0019 CPU points |
| 512 | 67,596–67,597 | 32 → 16 | 12.482 | 7.015 | 6.833 | 0.2825 CPU points |
| 4,096 | 76,162 visible; 44,798 hidden | 17 → 16 | 5.174 | 4.823 | 4.661 | 0.0257 CPU points |

The important mechanism is the **65,536-byte reply threshold**. At 512 lines,
each pane's JSON envelope is 68,632–68,633 bytes, so every call repeats the native
formatter and serializer. Retaining capacity alone saves 5.467 ms per 16-pane
save, or a modeled **0.2734 CPU percentage points at 0.5 saves/s**. Its five-trial
CPU range is 6.981–7.040 ms versus 12.477–12.526 ms currently. Removing the generic
reviver alone has little effect on this string envelope: prepared-JSON parsing,
byte conversion and base64 cost 0.900 ms with the reviver versus 0.882 ms without
it across all 16 panes. Avoiding the extra base64 Buffer copy is also much smaller
than avoiding the repeated native operation. The tiny 0/64-line differences
overlap trial variability and should not be treated as reliable savings.

Snapshot work is nonmonotonic with accumulated input. After 4,096 input lines,
whole-page pruning has reduced the hidden panes' retained snapshots below the
reply threshold; only the larger visible pane still retries. The pinned
Ghostty `PageList.grow` reuses an old page when allocation would exceed the page
budget, provided it can preserve the active area. The output sizes above show
the resulting history-size dependence; they do not establish a steady plateau.
At 20 lines/s, 512 input lines correspond to about 25.6 seconds of output, so a
short attached phase followed by a detached phase can encounter different
snapshot sizes and retry counts. Matching warm-up duration alone does not match
stream age; interpretation should record retained sizes or retry counts as well.

These results exclude fixture feeding, metadata capture, checkpoint object
copying, final checkpoint JSON serialization and disk writes. They project only
the terminal substage at 0.5 saves/s, not an integrated `recovery.save` improvement
or rigorous whole-application upper bound. The 16-pane sweep supplies a budget
for future unchanged-pane/closed-pane work; it does not benchmark cache hits.

This run used the same baseline native library SHA-256
`3a9a86b9e5658b3ba043faba81847e1ec998311b51ba783880bfb2e959c3245b`, Bun 1.4.4,
CPUs 8–15 and NUMA node 0. Each method warmed for 50 ms, then ran five 150 ms
trials with alternating order and forced GC outside timing. Total run time was
20.10 seconds. A CPU-0 observer sampled the selected cores and their SMT siblings
from before process launch through exit; the busiest sibling averaged 0.50% busy
over the complete run. This observes interference, rather than proving the host
was isolated.

Local artifacts: [raw trials](../../dist/terminal-costs/snapshot-node0.json),
[derived summary](../../dist/terminal-costs/snapshot-summary.json),
[full-run host samples](../../dist/terminal-costs/snapshot-node0-host.json),
[exact measured harness](../../dist/terminal-costs/snapshot-measured-source.ts), and
[production source diff](../../dist/terminal-costs/snapshot-source.patch).
The raw record includes source and native hashes. The current harness differs
from its frozen measured copy only in a descriptive note about history pruning.

Recovery also snapshots every `runtime.closed` terminal on every save. The limit
is eight per workspace and 32 workspaces, permitting 256 closed panes in addition
to live panes. On close, `Runtime.close` drains/reaps the terminal and calls
`stopShell`; `Terminal.stop` removes the readiness watch and closes its FD while
native code retains the screen/history. Current theme updates iterate live
panes only. Reopening reads a faded snapshot, starts a separate terminal and
destroys the closed terminal. No current path found in this audit feeds or resizes
the retained closed terminal, but the public terminal object is still mutable.

A cache should consequently be tied to terminal identity and revision, rather
than assuming all closed terminals can never change. Feed, resize, theme changes,
restore and stop advance the native surface revision. Retaining only the base64
snapshot could avoid reformatting unchanged live or closed terminals, at the
cost of retaining that string alongside the native terminal. This is a
source-supported opportunity, not a measured integrated saving. The current
all-agents-streaming workload has few live-cache hits and no closed panes.

## Damage-based native presentation: ownership and storage

The October 26 implementation replaces the two whole-screen fingerprint arrays
with exact previous semantic rows. This is a new implementation, not a claim
that the earlier retained-rendering prototypes improved whole-application CPU.
The v1–v4 sources/binaries and their measurements remain separate artifacts.

`native/zig/frame_diff.zig` owns the previous raw visible cell key, effective
Ghostty style, grapheme suffix and hyperlink URI/explicit ID. The latter bytes
are copied into reusable per-row arenas; no source Ghostty pin or borrowed
source string survives the synchronous composition call. A single scratch row
is swapped with each updated saved row. Comparisons select contiguous pane/UI
spans, rather than searching panes for every cell emitted. The existing precise
span output, style changes, Unicode width boundaries and OSC 8 semantics remain.
Small control/image-batch hashes remain; there are no cell fingerprint arrays.

The native mirror has per-row epochs, maintained when Bun installs positioned
row patches. Each differ owns its epoch receipts, so two installations before a
presentation accumulate, and another render consumer cannot clear the damage.
Untracked feed/resize changes conservatively invalidate every source row.
Identity/geometry changes invalidate the relevant rectangle; full ANSI replay
invalidates the chrome-layer receipt. Chrome can be reused without a parse, or
freshly parsed with its dirty rows clipped beneath opaque retained panes. The
native layer does not own sidebar, animation, layout or overlay policy.

The four-field `frame_diff_stats` ABI reports damaged rows, compared cells,
allocated cell slots and managed arena capacity. These counts are deliberately
limited: they do not include pane-edge validation, receipt lookup, UI parsing,
Ghostty render-state conversion, or bytes copied into saved rows. A damaged row
whose compared cells are all equal is not copied. When any interval actually
changes, `captureRow` currently copies the **entire host-width row** into the
scratch row, including unchanged surrounding UI, to keep all managed slices
owned by the new row arena. Sparse comparison therefore does not imply a
similarly narrow copy. Scrolls generally damage all shifted visible rows.

Pinned Zig 0.16 ReleaseFast layout diagnostic (`CORGI_NATIVE_LAYOUT_DIAGNOSTIC=1
./scripts/zig build --build-file .../native/build.zig -Doptimize=ReleaseFast
test-frame-diff`) measured `Cell=96`, `OwnedRow=56`, `Receipt=48`, `Range=16`,
`ArrayList(Range)=24` and `Differ=5,880` bytes on this x86-64 host:

| Host geometry | Fixed cells, including one scratch row | Saved-row descriptors | Damage-list descriptors | Damage-range allocated capacity after first full frame | Changed flags | Managed arena capacity for blank frame |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 160×48 | 752,640 B | 2,688 B | 1,152 B | 6,912 B | 160 B | 0 B |
| 64×12 | 79,872 B | 672 B | 288 B | 1,728 B | 64 B | 0 B |

These figures exclude the 5,880-byte differ object (which embeds the scratch-row
descriptor), Ghostty terminal/render state, allocator metadata, the output
buffer, FFI pane-reference capacity and pane receipts. Receipt storage costs
48 bytes per allocated slot plus 8 bytes per allocated row epoch. The terminal
also owns its source epoch array, separately from each consumer's receipt.
ArrayList capacity grows above its logical length and is retained; the table's
range storage is allocated capacity, not merely one 16-byte interval per row.
Managed capacity varies with actual grapheme and link data and can retain a
past high-water mark. This first version intentionally favors explicit ownership
over a compact common-cell representation; any later layout change needs its
own measurement.

Eleven focused native tests pass, including separate consumers, accumulated row
epochs despite Ghostty dirty-flag cleaning, cursor-only reuse with zero compared
cells, one-row sparse damage, source destruction after managed-byte capture,
identity/move invalidation, full replay recovery, overlapping/wide-boundary
rejection, styles/links/Unicode and image controls. The initial 96-byte-cell
library SHA-256 is
`61c21c65db3c3fd747a731c0ea2a238e6203bc82acff709a43f0927555fc96d3`.
This section records ownership and measured layout, not CPU performance.

The subsequent compact layout keeps the same ownership and damage contract,
but stores only raw cell data, the unmodified Ghostty style and a nullable
pointer in each common cell. The measured sizes are `Cell=48`, `Style=28` and
`Managed=56` bytes. Fixed cell storage therefore falls to **376,320 bytes at
160×48** and **39,936 bytes at 64×12**; the other fixed descriptor sizes above
are unchanged. Managed records live in the same row arenas as their owned
grapheme/URI/ID bytes. Equal neighboring managed records share one allocation,
including across a hyperlink run. A distinct grapheme cell can cost 48+56 bytes
before its payload, versus the previous 96-byte cell, so a fully rare-data-heavy
screen can use more memory despite the common-cell reduction.

This change also removes the 96-byte borrowed temporary on every compared cell.
The common comparison inlines the normalized raw-key comparison and style
comparison, short-circuiting before looking up managed data. Capture inlines
ordinary cell stores and calls a separate allocator helper only for actual
graphemes or hyperlinks. The initial generated code had out-of-line `borrow`
and `OwnedRow.put` functions with substantial stack frames. In the accepted
node-1 initial-layout microbenchmark, comparison plus row capture accounted for
about 301 microseconds of a static-UI scrolling presentation, versus 6.5
microseconds emitting output; that measured phase motivates this compact
experiment. Its independent performance result must be established by the
subsequent benchmark, not inferred from the storage reduction.

That follow-up passed exact output/surface checks on both NUMA nodes. The
accepted [node-1 compact result](../../dist/composition-compact-node1.json)
reduced scrolling comparison-plus-capture to about 96 microseconds with stable
chrome and 109 microseconds with changing chrome, versus 301 and 298 in the
[96-byte-cell run](../../dist/composition-exact-node1.json). Pure composed
scrolling took 225 microseconds of process CPU versus 265 for frozen PR15 full
replay. Production mirror installation plus composition with changing chrome
took 369 versus 501 microseconds for frozen JSON installation plus full replay.
These are isolated pipeline results, not whole-application measurements. Stable
idle/cursor-only fixtures compared zero cells, sparse changes compared one
132-cell row and scrolls compared 47 rows/6,204 cells. The diverse fixture's
managed arena grew to 22,638 bytes versus 2,352 with the original layout,
remaining stable across repeated cycles; fixed cell storage fell by 376,320
bytes. The compact native library SHA-256 is
`f2133e4f7848c2408bab75923e99c4a544c27bf1a750fdfc3cfd0b42def173a9`.

## Retained chrome patches and canonical producer rows

The v8 compositor accepts three chrome modes: full, reuse, and a restricted
positioned repaint patch. A patch preserves the existing chrome VT and clips
its damage beneath retained panes. The TS owner verifies the preceding complete
chrome and pane geometry; native code also verifies pane receipts and rejects
unsafe controls, image changes, and incomplete sequences before replay. Existing
stable image receipts survive a patch. Wide-cell overlap discovered after
parsing invalidates the retained state and uses the complete-frame fallback.

Ghostty marks both old and new cursor rows dirty for ligature shaping, including
when the cursor is hidden (`Screen.cursorChangePin`). A two-row repaint therefore
does not necessarily cause two damaged rows. The native fixture moves its cursor
through rows 0 and 7 and paints rows 1 and 2 on an eight-row screen: exactly those
four rows are dirty, four remain clean, and comparison covers 64 cells after
clipping two retained pane rows, or 72 when one eight-cell pane row also changes.
This is cursor invalidation, not a retained full-screen dirty flag. V8 passed
16 native tests; [the build log](../../dist/native-chrome-patch-build.log) records
the ReleaseFast build.

The v9 producer cache retains canonical UTF-8 ANSI rows per native terminal.
It allocates row buffers only after a surface request. Each completed render
invalidates the affected cached rows; these bits accumulate across text and link
consumers until capture formats them. Global damage, geometry, pane-ID changes,
or previous/current links invalidate the whole cache. The link fallback is
deliberately conservative: automatic link IDs include flattened UTF-8 offsets,
so editing an earlier row can change a later link's ID across a hard newline.
Ghostty's reverse-video mode changes default foreground/background without
setting row damage, so the cache separately compares those two colors.

Render dirty flags are acknowledged only after link and graphics snapshots
succeed. A failure invalidates cached rows and requests a full render rebuild
on retry. Synchronized output continues to return its completed frame. Borrowed
viewport captures force full invalidation on entry and restoration, preserving
independent viewer scroll/selection behavior.

This first cache keeps the existing owned-snapshot contract: **every surface
still copies each row into its caller's allocator**, then serializes the full
native JSON result and the existing wire payload. It removes repeated formatting
and reuses writer capacities; it does not remove those payload copies or JSON
passes. The cache retains one additional encoded screen plus row descriptors.
`terminal_surface_cache_stats` reports cumulative formatted/reused rows and
current encoded length/capacity; the byte counters exclude descriptors, caller
snapshots, and JSON buffers. A separately scoped borrowed serialization API could
remove the snapshot copies later, but cannot silently replace owned snapshots.

The same native revision adds `terminal_live_text`, returning the existing
active-screen text as owned UTF-8 bytes with the same explicit free convention
as ordinary recovery snapshots. It leaves the JSON operation available as an
independent reference and moves no provider detection policy into native code.

The v9 native build passed **35 pane tests and 16 compositor tests**. New tests
compare cached rows directly with the original row formatter and cover dirty
accumulation, old snapshot ownership, sync holds, cross-row Unicode/link IDs,
soft wraps, explicit links, pane IDs, selection/colors, resize/alternate screens,
viewport restoration, and allocation/write retry. See
[the native build log](../../dist/native-surface-cache-build.log). The installed
library SHA-256 is
`620d2f2fa9cf8d3e4bb0bc6612129f475cd5fb9ae1e88d647da958ce3a0c1e80`.
Performance measurement of this revision is pending; correctness and reduced
format counts alone do not establish a whole-application gain.

## V12 viewer geometry and frame-copy candidate

The v9 diagnostic's streaming phase recorded 746 main-thread samples. Its
`Controller.area`/`sidebarView` stack appeared in 67 samples (8.98%, inclusive),
and `View.clone` had 27 self samples (3.62%). These are diagnostic sample shares,
not process CPU percentages or a prediction of the v12 gain. V10 already removed
some layout reconciliation work within this stack.

Previously every pane-area lookup constructed a sidebar View and cloned it five
times through search, preferred width, review panel, workspace paging and entry
setup. Each clone copies the View's 27 own fields. Geometry needs none of the
agent offsets, list capacities, workspace counts, resources or labels. The v12
candidate uses View-owned scalar width/clamping and rectangle functions, shared
with the full View methods. It returns the same Rect without those six View
objects or 135 clone field assignments. Lookup occurs independently while
building sync interests, checking retained composition, and acknowledging the
presented panes. No geometry cache or native UI policy is introduced.

Animation deadlines also used to refresh a retained frame before calling
`repaintSidebar`, which refreshed it again. Passing the already-computed cursor
to `repaintSidebar` removes one intermediate Frame, pane array, pane record per
pane and visible cursor object from each such tick. This also avoids the
intermediate constructor's discarded empty array and chrome-receipt object.
The surviving frame still captures fresh pane revisions and owns its cursor;
earlier frame receipts remain untouched. These are source-level allocation
counts, not measured allocation events or a CPU-speed claim.

Native row-epoch receipts are a lower priority: for one 47-row pane, each u64
epoch array is 376 bytes. A presentation compares two such arrays and copies
376 bytes into the receipt (about 1.5 KiB of nominal reads/writes before cache
effects). This is much smaller than copying
one changed 160-column semantic row (7,680 bytes of fixed cells, plus any managed
data), and the epoch arrays are already retained. Removing them would complicate
independent consumers and accumulated damage without evidence of a material gain.

## V13 viewer loop cleanup candidate

The normal viewer loop called five async functions even when they had no work
to await: clipboard delivery, dormant-pane waking, launcher polling, its nested
inline-command preview, and account-removal completion. The candidate returns
synchronously from the first three when no async action is needed, bypasses
the nested command preview when no launcher exists, and skips an empty removal
map. Clipboard probing/timeouts and output flushing still happen on every pass;
launcher preview polling also remains on every pass. The outer maintenance
Promise and all frame/input scheduling deadlines remain unchanged. These are
five removed no-op async invocations/awaits per ordinary pass, not measured
JavaScript allocation counts or a CPU-speed claim.

The first v13 candidate also retained successful PTY dimensions until SIGWINCH
or SIGCONT. Integration rejected that change: `Bun.Terminal.resize` changed the
PTY's ioctl dimensions without reliably delivering SIGWINCH to the attached
viewer. Both clipboard smoke cases completed their clipboard actions, then
failed waiting for a resized frame. V13b restores the original per-loop ioctl
and removes the cache-only tests; the existing real-PTY integration cases cover
this behavior. No delayed polling workaround or injected test signal is used.
The original v13 source, binaries and failed integration log remain in `dist/`.
Clipboard tests still cover event-before-result ordering, timeout delivery and
failure cleanup.

The v12 diagnostic attributed only 32.7 ms to preparation and 22.4 ms to
maintenance across 60 seconds. Their combined elapsed-time budget is below
0.1 percentage point; this cleanup is therefore not expected to explain the
remaining whole-viewer gap by itself. The blanket 16 ms active polling cap is
unchanged. Replacing it requires accounting for terminal probe fragments,
clipboard deadlines, badge retries, input escapes, UI transitions and host
pacing; that broader scheduler work is deferred pending stronger attribution.
