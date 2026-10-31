# Native mirror release: V18 evidence and remaining experiment

V18 used 8.07 MiB less viewer PSS than V15 in one balanced four-process block:
67.87 MiB (67.48–68.26) versus 59.80 MiB (59.36–60.24). Combined CPU was flat,
5.983% versus 6.008% of one core. Viewer CPU was 1.792% versus 1.717%, but V18
also changes the viewer's ordinary wait cap and calibration flagged up to 13%
environmental drift. This is evidence of a memory benefit for the combined
candidate, not an isolated CPU benefit from release. It is not a Herdr comparison.

The fixture visits all sixteen panes before timing, so releasing previously
visited VTs targets a real retained allocation. The earlier V14 memory ladder
measured 13.68 MiB more PSS after visiting fifteen additional panes; that was a
different, quiescent component fixture, not a prediction of pages returned by
the allocator. The new same-binary policy experiment below will isolate release.

Raw macro evidence and quality details are in
`dist/retained-v18-v15-aligned/` and `viewer_heartbeat_findings.md`. V18 binary
SHA-256 is `f792622d85f00f2b5b0f6ee8b9b3c921bcd14b81d5ac450e3006c70fb72c9163`.
Its frozen source is `/tmp/v18-memory-source-frozen-20261026`, SHA-256
`9ad1c0c8b81d16562c2618242c3a0d3454c95b794f55ca90be45f9fa190a8de0`.
The four native assets are unchanged, aggregate SHA-256
`f47eecce50af1f1f0130dbf484165706639f8c04cc74532859555b00acf48cac`.

## Correctness and ownership review

`mirror.Terminal.release()` frees only the native VT and derived row/link caches.
It retains the last canonical View, including modes, and leaves the receipt,
requested viewport, pending input and image metadata intact. Selection and
selection gestures pin the native instance. Mirrors without a canonical View
also remain allocated, so default or otherwise unrepresented native state is
not discarded. No production caller directly feeds, resizes or themes a mirror
outside its own methods.

Every handle access passes through `ensure()`. Restoration installs the full
retained View and render state before returning the handle, without calling
public `receive()` or modifying acknowledgement/viewport state. Input encoding
therefore sees the saved modes even before the next RPC. Native identity and
render revision change, invalidating old presentation receipts. A newer incoming
surface first restores the old baseline and then calculates new row/cursor
damage; restoration cannot accidentally clear the new damage flag.

`viewer.releaseUninterested()` retains visible split placements, the pane ghost,
and separately the workspace ghost's cached layout. Workspace ghosts are not
new RPC subscriptions. The native differ owns its displayed cells and retains
no borrowed pane pointer after a synchronous compose call. JS Frames retain
Mirror objects, not freed native handles. Image payload ownership stays in the
viewer image manager; releasing a text VT does not delete those image objects.

The frozen candidate passed 50 focused tests, 1,940 full unit tests (one skip),
types/formatting and production/test/browser builds before its macro run.
Focused regressions cover exact styled/wide/link/cursor surfaces and final
Differ output, input modes before RPC, same-stamp replies with no surface,
newer sparse rows after release, resize/replacement, failed hydration retry,
selection pins, pending viewport/input and split/ghost allocation stability.
Later integration/visual results belong to root's validation receipt.

## Unrun same-binary memory experiment

`viewer_memory_subject.ts --release-hidden` calls the actual viewer helper after
each focus/installation and on the final return to pane 1 without a new surface.
It checks one initialized VT after every draw. Without the flag, `visited16`
keeps sixteen VTs. Both policies keep the same canonical Views, final visible
screen and selected pane. The flag is reported in the subject and runner
receipts. Reflective helper lookup keeps the default subject compatible with
older frozen source; requesting release against a missing helper fails.

Build one default-options subject against the frozen V18 source and native
assets. Do not change the frozen tree, GC settings or heartbeat implementation.

```sh
bun tools/benchmarks/viewer_memory_build.ts --source /tmp/v18-memory-source-frozen-20261026 --native-root /tmp/v14-memory-native-frozen-20261026 --reference dist/corgi-retained-v18.build.json --out /tmp/viewer-memory-v18-default
```

After a CPU slot is granted, compare fresh processes at age 30 seconds, with
three paired repetitions. Measure `metadata16` and `visited16`; the former is a
control with one initialized VT under both policies. Run policy groups in order
off/on, on/off, off/on; each group uses `--repeats 1` and its own fresh directory.
Use the same per-pair seed so the two modes have the same order in each pair.
For example, the first off/on pair is:

```sh
python3 -B tools/benchmarks/viewer_memory.py /tmp/viewer-memory-v18-default dist/viewer-memory-v18-pair0-off --age 30 --repeats 1 --seed 20261026 --node 0 --cpus 24-31 --modes metadata16 visited16
python3 -B tools/benchmarks/viewer_memory.py /tmp/viewer-memory-v18-default dist/viewer-memory-v18-pair0-on --age 30 --repeats 1 --seed 20261026 --node 0 --cpus 24-31 --modes metadata16 visited16 --release-hidden
```

Placement is prospective and may be changed before any trial if the host pilot
requires it; record the selected topology. All runner invocations perform
separate correctness verification first. Compare final surface hashes across
both policy groups as well as within each group. Capture full smaps/rollup/maps
before heap statistics, verify source/native/binary identities, retain every
attempt, and check cleanup. Report PSS/private/anonymous memory and native
instance counts separately; heap statistics and RSS are not allocation totals.

## Unrun revisit-cost experiment

Use a small companion component tool importing the same frozen V18 modules.
Prepare sixteen independent canonical Views before timing, with 132×47 styled
wide/combining/link content and distinguishable rows, cursor positions and input
modes. Start from one Controller/Differ and sixteen visited panes. Use actual
`releaseUninterested` for the enabled policy. Fix time and decoration settings
so incidental animation or random playback does not obscure focus work.

Measure two separate paths with the same implementation and inputs: first an
unchanged revisit with no surface response, then a revisit receiving a newer
sparse View. Include focus, release-policy pass, input-mode/key query, compose
and diff. Report process user/system CPU per visit and wall p50/p95/p99; collect
native creation/release counts outside timing or label instrumentation overhead.
Warm both policies equally, then use fresh-process off/on/on/off trials with a
fixed number of round-robin visits. Preserve ordinary GC and report maxima;
reconstruction and allocator reuse are part of the tradeoff. A separate slow
human-paced sequence can assess latency after idle aging if the tight component
loop shows a material penalty, rather than assuming the loop predicts it.

Correctness runs must verify after every visit: exact native cells/styles/links
and cursor, input encoding before any RPC, unchanged `known` receipt on a
no-response return, identity/revision advancement after release, and accumulated
Differ output matching the full ANSI reference. For the newer-frame case also
verify the new receipt and shortened/wide-cell erasure. Keep CPU timing free of
reference rendering, host-terminal replay and JSON fixture generation. This
measures revisit overhead, not a steady application CPU saving.

## Lower-complexity bundle experiment

The existing benchmark builder's opt-in `--bytecode-split` is a smaller
architectural change than splitting viewer/daemon source modules manually. Its
three build options are `{ bytecode: true, splitting: true, format: "esm" }`;
the default is unchanged. Pinned Bun source/tests support this combination.
See `bun_compiled_memory_audit.md` for exact source references and limitations.

Compare it separately against the same V18 default subject, with release policy
held fixed, initially in `empty`, `viewer`, and `metadata16` modes. The V14 empty
bundle's 10.97 MiB PSS contrast with tiny Bun makes this worth measuring, but
does not establish how much is removable. Splitting preserves eager imports:
`main.ts`, `mirror.ts` and `pane/terminal.ts` still reach provider adapters, so
it cannot remove all viewer-loaded code. Embedded bytecode can also move owned
instruction data into executable-backed mappings; private, anonymous and file
PSS must be examined separately. A successful ladder build alone does not prove
production compatibility: both real worker URL factories, assets, relaunch,
integrations and release platforms need validation before changing `build.ts`.
