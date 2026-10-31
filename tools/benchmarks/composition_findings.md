# Retained composition findings

The first sections preserve the historical v3 diagnostic, not the final result.
The v4 source and binary are archived under `dist/retained-v4-*` and
`dist/corgi-retained-v4`. Subsequent work removes whole-cell hashes in favor of
exact comparisons of damaged regions; see [validation](retained_validation.md).

`composition_costs.ts` generates fixed frames through the real Corgi renderer:
160×48 host, 28-column sidebar with 16 working agents at intensity 50, and one
132×47 pane. Every frame changes both UI chrome and pane cells. The sparse and
scrolling cases use the streaming CPU fixture's line format; a third case adds
alternating pane foreground styles. Animation timestamps are fixed, and all
inputs are generated before timing.

The benchmark compares frozen PR15 native full-frame diff, current native
full-frame diff, and current native composition in the same process. CPU trials
include FFI and copying output into a reused buffer. They exclude UI rendering,
source terminal updates, surface transport, pane ANSI materialization, and JS
output allocation. This isolates the native change; it is not an end-to-end
viewer result.

## Result

The native full-frame path regressed substantially. Composition reduces parsing
but does not recover the baseline's performance. Hashing dominates the current
native work and needs investigation before another full workload comparison.

Node 1 median process CPU, µs per frame, six alternating 150 ms trials:

| Input | Frozen full | Current full | Current compose |
| --- | ---: | ---: | ---: |
| Sparse | 260.0 | 417.0 | 418.2 |
| Scroll | 244.0 | 441.0 | 410.8 |
| Styled scroll | 248.7 | 418.5 | 389.5 |

Node 0 independently reproduced the direction: frozen full 243–256 µs,
current full 422–431 µs, and current compose 392–418 µs. Node 0 had up to 6.08%
average SMT sibling utilization during the run; Node 1 had at most 0.81%.
These are whole-run averages, not per-trial interference bounds. The process
was bound to CPUs 8–15 with memory node 0, then CPUs 72–79 with memory node 1.
Both runs held the common benchmark lock and ran serially.

Separate optional phase clocks, node 1 sparse input, µs per frame:

| Path | Parse | Render update | Hash | Emit |
| --- | ---: | ---: | ---: | ---: |
| Current full | 120.06 | 7.26 | 299.02 | 5.27 |
| Current compose | 91.02 | 6.40 | 293.87 | 5.20 |

These counters measure monotonic wall time, including possible preemption. They
are disabled during the CPU trials. The full and composed paths hash the same
7,680 final cells in v3: 1,476 exposed chrome cells plus 6,204 pane cells.
V2 additionally hashed the pane's 6,204 blank cells in the temporary chrome
terminal. V3 avoids that duplicate scan, but the current per-cell hash work
still takes roughly 70% of native time.

Each complete input averages 20,573 bytes; chrome averages 12,309 bytes.
Retaining the pane removes 8,264 bytes of parser input (40.2%). On the sparse
diagnostic, parsing falls by about 29 µs (24%). That saving is outweighed by the
regression visible even when both implementations receive identical complete
ANSI inputs. Machine-code inspection subsequently identified the cause:
extracting the hash loop caused generic Wyhash update/finalize calls and small
copies to remain in the per-cell loop. The frozen binary had inlined those
constant fragments. Packing the same original variable-length key into a stack
buffer restored full-replay performance to roughly the frozen baseline.
Avoiding repeated hashes of adjacent identical unmanaged cells reduced native
composition to 148–149 µs for these padded inputs, versus 236–249 µs frozen full
replay. The diverse Unicode/color fixture improved only 4% (347 versus 361 µs).
These are native microbenchmarks, not demonstrated application savings.
Raw follow-ups are `dist/composition-costs-compact-node1.json` and
`dist/composition-costs-memo-diverse-node1.json`.

## Correctness and provenance

Before timing each case, the harness compared two complete 16-frame cycles,
including the last-to-first transition. All three paths produced byte-exact
output and identical complete terminal surfaces and cursors. Across both NUMA
nodes, 576 surface comparisons and 384 frame-output comparisons passed. Sparse
output totals 12,022 bytes per 32 transitions, scrolling 57,082 bytes, and styled
scrolling 77,146 bytes, identically for all paths.

The baseline is the frozen embedded PR15 library, copied under
`dist/retained-native-pr15/`; its SHA-256 is
`3a9a86b9e5658b3ba043faba81847e1ec998311b51ba783880bfb2e959c3245b`.
The other worktree's build output is mutable and is not used as the baseline.
Raw results include current native/source hashes, fixture hashes, CPU affinity,
memory policy, each trial, phase counters, and SMT load:

- `dist/composition-costs-node0.json`
- `dist/composition-costs-node1.json`

Commands, run serially in the exclusive benchmark slot:

```sh
env -u CORGI_NATIVE_ROOT -u CORGI_TELEMETRY_DIR numactl --physcpubind=8-15 --membind=0 bun tools/benchmarks/composition_costs.ts > dist/composition-costs-node0.json 2> dist/composition-costs-node0.log
env -u CORGI_NATIVE_ROOT -u CORGI_TELEMETRY_DIR numactl --physcpubind=72-79 --membind=1 bun tools/benchmarks/composition_costs.ts > dist/composition-costs-node1.json 2> dist/composition-costs-node1.log
```

Both commands exited successfully; stderr logs are empty. The tool was formatted
with the repository's pinned Prettier. No production changes were made for this
benchmark.

## V9: retained sidebar detail rows

V9 keeps UI policy in TypeScript. The sidebar prepares its static ANSI chunks
once, including workspace rows, headers, agent names, context figures, rails and
backgrounds. Each visible agent has one explicit detail-row callback. That
callback is the same byte-emitting block used by the complete renderer, covering
its activity glyph, corgi or text, elapsed compaction time, and subagent badge.

An animation deadline advances the existing presentation objects and dreamer,
with the same `beginFrame`/`observe`/`endFrame` lifecycle and deadline policy.
Only changed detail-row fragments become native patches. Small fragment strings
are compared directly; there is no whole-frame hash. Every patch establishes its
background and inherited foreground and clears the old activity glyph, including
wide characters. The complete renderer's ANSI writes remain identical to frozen
V8; the additional rendition setup exists only in patch delivery.

Each composition frame owns an immutable set of current fragment strings. Its
full chrome is a lazy join of those fragments and static chunks. Opaque receipts
identify the base accepted by the native differ, so ordinary equality and patch
selection do not force full-string construction. A skipped base installs complete
chrome; native rejection retains the complete-frame fallback. Materializing a
fallback never calls animation drawing again and cannot change the frame's time.
The diagnostic compose timer also avoids reading lazy chrome just to count bytes;
the differ records the bytes actually transferred.

Entry arrival/departure, move, the 650 ms lost-conversation hold, ghost borders,
spotlight, and workspace push/naming animations use the V8 complete-sidebar path.
Once existing row transitions settle, that path prepares a new stable plan.
Metadata, resources, input state, layout and graphics invalidation continue to
force ordinary composition. Plan allocation is limited to the same single-pane
normal-view conditions that permit Controller caching. Static image placements
remain in retained chrome; pane images and affected overlays take their existing
fallback paths.

With a 160×48 host and a 132×47 pane starting at column 28, a patch touching
`D` agent detail rows makes at most `28 × D` exposed chrome cells eligible for
comparison on those rows. The native layer already excludes the retained pane
columns. This is a work-count model, not a measured application CPU saving.

Validation for frozen `dist/corgi-retained-v9`:

- Full TypeScript suite: 1,886 passed, one opt-in inference test skipped,
  no failures; focused suite: 130 passed with 1,544 assertions.
- Native checks: 51 passed. Typecheck and production build passed.
- Detail-row tests compare patches with complete styled surfaces across awake,
  sleeping, compacting, focused, hovered, notes, context-pressure and grouped
  entries, including Unicode and dotted underlines. They also cover immutable
  old frames, lazy fallback, dropped bases, unchanged snapshots, preserved
  animation delays, and transition fallback/rearming.
- Real PTY comparison against frozen PR15: all 19 states matched styled cells,
  hyperlink targets, cursor, and decoded image pixels/placements. I also inspected
  the generated normal/Unicode, held-selection, Kitty-image, dimmed-dialog and
  split-pane comparison PNGs. This quiet-sidebar fixture does not independently
  exercise continuously animated agent rows.

The screenshot evidence is in `dist/retained-visual-v9/`, including
`comparison.json`; the command/log is `dist/retained-visual-v9.log`. The frozen
binary SHA-256 is
`8df78d85604b059b9944cf84c6a0c7eca4b29fd75e3670d53184ae415d038bd8`;
source archive and manifest are `dist/retained-v9-source.{tar.gz,json}`.

Actual V9 performance is pending. `controller_costs.ts` measures real
`Controller.compose()` plus native `Differ.diff()`, including UI generation and
output-buffer allocation, from identical harness copies in frozen V8/V9 source
trees. Seven workloads cover spinners, awake/sleeping/compacting corgis, quiet UI,
sparse pane updates and scrolling. Its 48-frame verification emits complete ANSI,
host-output and styled-surface hashes for comparison across versions before CPU
trials. The existing `composition_costs.ts` precomputes UI and therefore cannot
measure this sidebar change.

The first cross-version verification exposed an unseeded fixture: awake corgis
choose routines from cryptographic randomness. The harness now resets each public
presentation and seeds its playback from the pane ID before each fixture. With
that correction, all seven workloads match V8/V9 for complete ANSI, diff output,
styled surfaces and output counts across 336 frames. Raw results are
`dist/controller-v{8,9}-seeded-verify.json`; production animation policy was not
changed to obtain this equivalence.
