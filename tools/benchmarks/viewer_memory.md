# Viewer memory audit

Source review and existing measurements, 2026-10-26. No new application process
or memory benchmark was started for this audit.

## What is measured

The saved V8 sparse run (`dist/retained-v8-herdr-sparse/*-node0-try1/results.json`)
contains these `smaps_rollup` snapshots after its CPU/quality windows:

| Viewer | RSS MiB | PSS MiB | Anonymous PSS MiB | File PSS MiB |
| --- | ---: | ---: | ---: | ---: |
| Corgi | 88.34 | 68.71 | 48.00 | 20.71 |
| Herdr | 14.85 | 9.05 | 2.56 | 6.48 |

About 45.43 MiB of the 59.66 MiB PSS difference is anonymous memory. That includes
JS/runtime heap, JIT and native allocations; the rollup cannot separate them.
There is no saved per-mapping `smaps` breakdown or empty-Bun control for this run.
Consequently this evidence does not assign the gap to Bun's baseline, imported
code, terminal state, or a leak. RSS also includes shared pages.

## Concrete allocation boundaries

`mirror.Runtime.receive()` constructs a `mirror.Terminal` for every pane in the
snapshot, including hidden panes. In V9 its constructor immediately constructs
the native terminal. The 16-pane/one-visible fixture therefore owns sixteen native
VTs before fifteen of them receive any surface. These objects are necessary only
when a pane is displayed or its input modes are queried.

Each `pane/terminal.Terminal` also eagerly requests a 65,536-byte PTY-read buffer.
That buffer is used only by `drain()` after checking for a real FD; viewer mirrors
never own that FD. Sixteen buffers account for exactly 1 MiB of requested buffer
storage, not necessarily 1 MiB of resident pages. This is independent of native
VT allocation and cannot explain the whole anonymous-memory gap.

V10 subsequently made the PTY buffer allocate on first drain and the mirror VT
on first surface/input/render use. Mirror construction retains
dimensions; first surface initialization uses the incoming geometry. Clearing
selection or destroying a never-used mirror does not allocate; destruction is
idempotent and prevents revival. A constructed VT remains owned until pane
removal. There is no eviction policy or repeated reinitialization on tab switches.
Tests validated native creation counts, default modes/key encoding, receipt and
resize behavior, held/empty surfaces, and cleanup. Native bytes saved per
untouched pane and causal process-memory savings have not been measured.

## Startup dependency opportunities

These are source dependency boundaries, not measured resident-byte attribution.
Bun's compiled bundle can eliminate unused exports or defer function compilation;
source bytes and import counts must not be reported as heap savings.

- `providers.ts` statically imports the full Codex, Claude, Pi and OpenCode2
  adapters. Their indexes bring headless engines, transcript parsers, observers,
  launch integration, renaming and usage readers into the dependency graph even
  when UI callers only need a name, capability or model label. A small provider
  metadata registry separate from operational adapters is the most useful broad
  boundary. Viewer account/setup actions need their existing explicit operations;
  moving every adapter behind an async call without classifying those uses would
  introduce unnecessary complexity.
- The Codex adapter imports `codex/rename.ts`, which imports `visibleWidth` from
  the `@earendil-works/pi-tui` package entry point. That package reexports its TUI,
  Markdown/Marked, editor, image and platform modules. Its width utility itself
  creates two `Intl.Segmenter` objects and Unicode regexes at module evaluation.
  Delaying this rename-only helper or using an appropriately narrow package entry
  avoids coupling normal viewer startup to it. Replacing its width semantics with
  Corgi's width function requires explicit equivalence tests.
- OpenCode2's adapter reaches `api.ts` (`bun:sqlite`) and observer/worker code.
  Those features do not run merely because their modules are imported. Their
  operational imports belong behind the provider execution boundary.
- `mirror.ts` needs resource `Snapshot`/`fromJSON`, and the sidebar needs resource
  text formatters. All come from `trackers/resources.ts`, which also imports
  `resource_os.ts` and owns sampling/Worker policy. Separating wire/value types and
  formatting from the sampler is a small boundary with clear viewer ownership.
  The viewer does **not** start the GPU resource Worker simply by importing it;
  GPU sources already load in the Worker.
- `main.ts` imports updates, which imports the recovery-path helper from a module
  that also imports checkpoint/runtime code. Put the path helper with other path
  policy, or defer recovery operations. This is a source coupling to inspect in
  the generated bundle, not proof all daemon classes currently become resident.
  Main already imports the server and attached client dynamically by command.
- Controller imports onboarding/import support, setup/bug-report collection and
  the Moonlander terminal module before those features open. Their states are
  mostly null initially; heavy buffers are generally allocated by methods later.
  Async feature-open boundaries are plausible, but lower priority than unnecessary
  native objects and provider/resource separation without measured retained heap.

The normal animation module eagerly creates 256 presentation slots and its small
frame tables. That is real startup work but there is no evidence it dominates
the memory gap. Moonlander glyph data is about 14 KiB of source, and large image
atlases are created on demand, so attributing tens of MiB to that import would be
unsupported.

## Native libraries and Bun baseline

`native_ffi.ts` opens the terminal and system libraries and builds FFI wrappers;
`native_bridge.ts` opens the same filenames for its JSON interfaces. Repeated
`dlopen` of the same library does not imply duplicate physical code mappings.
The viewer needs terminal/render/input operations and several system probes.
Splitting unused bindings might reduce wrapper/setup work, but needs measurement.

The current libraries occupy about 18.1 MiB on disk, while `size` reports about
3.91 MiB total ELF text/data/BSS sections across both. Neither number is resident
memory, and the larger file size is not a valid estimate of viewer DSO RSS.
Likewise the 133.8 MB compiled executable is not 133.8 MB of resident Bun code.

A later isolated memory ladder should use the same Bun release/build settings:
empty compiled waiting process; native libraries only; viewer import; Controller
without panes; one visible pane; sixteen metadata panes with one visible; then
sixteen panes actually displayed. Capture full `smaps` plus rollup, JS heap and
external-buffer counters at the same warmup ages. Keep forced-GC diagnostics
separate from ordinary steady samples. That establishes the Bun/native baseline
and per-pane slope before claiming import or lazy-construction savings.

## Proposed controlled ladder

The first controlled run of this plan is now documented in
`viewer_memory_findings.md`. The older production comparison above is retained
as motivation; the ladder separates initialized component boundaries rather
than assigning the entire production difference to Bun.

Use one compiled subject with seven runtime-selected modes. Its entrypoint must
have no static application imports: each mode imports the next dependency only
when selected. The same executable then contains the same application code and
native assets in every case; differences reflect module evaluation, initialized
objects and touched mappings, rather than different compiled file sizes. Check
the process maps in the empty mode to confirm that no native library was loaded.
An additional tiny compiled waiting control can distinguish Bun plus the common
measurement shim from the presence of the larger application bundle. Keep that
control separate from the seven within-executable comparisons.

| Mode | State held before the ready marker | Difference being tested |
| --- | --- | --- |
| Empty | Common waiting/control shim only | Baseline for this compiled executable |
| Native bindings | Actual `native_ffi` and `native_bridge` modules, no VT | DSO mappings, wrapper setup and native initialization |
| Viewer import | Actual `viewer` module, no Controller | Evaluated dependency graph and module globals |
| Controller, zero panes | Controller plus a 160×48 Differ, with its first empty frame presented | A ready UI, including the host VT and first render allocations |
| One visible pane | One pane's metadata and a canonical 132×47 surface, composed through the actual Differ | First populated pane and its mirror VT |
| Sixteen metadata panes | Same visible pane plus fifteen metadata-only panes | Hidden-pane metadata while their VTs remain uninitialized |
| Sixteen visited panes | Each of those panes displayed once, then focus returned to pane one | Retained VTs and pane surfaces after visiting every tab |

The Controller cases share preferences, image policy and geometry. Populated
cases finish focused on pane one with the same pane cells; the sidebar naturally
differs by pane count. Construct no PTYs or provider subprocesses. A transport
fixture should fail on unexpected RPCs; suppress only asynchronous discovery
that cannot run without a daemon, and list each suppression in the manifest.
Create canonical input surfaces in a separate setup process, so the measured
viewer never owns a producer VT. Send only the inputs needed for the case and
drop fixture references after installation. Do not retain an entire sixteen-pane
corpus in the one-pane subject. Verify native creation counts and final surfaces
in an untimed validation run before collecting memory.

The first ladder measures initialized, quiescent state. It does not recreate
the production viewer's sustained polling, animation, JSON allocation or JIT
history. A real-viewer reference under the existing workload, at the same age,
is needed to measure that residual. It would be misleading to assign the
remaining production gap to imports merely because the import stage is large.

Build with the exact Bun release and architecture used by the production binary,
and the options from `build.ts:102`: `target: bun`, the same compile target, no
new minification/bytecode/debug settings, and the same worker entrypoints. Reuse
the native asset/config substitutions with `testBuild=false` and the frozen four
native files. Record executable, build-script, subject, fixture, Bun and native
SHA256 values. Pre-extract the verified assets in a separate setup process;
leave `CORGI_NATIVE_ROOT` unset during subjects so the ordinary embedded lookup
path is exercised without measuring first-time extraction garbage.

Run serially under the existing CPU slot with fixed CPU/memory-node placement.
Use a fresh process per mode, replicate and observation age. A compact first
sweep can use a common 30-second age after each ready marker; a confirming sweep
can use 120 seconds for every mode. Also record process-launch age and setup
duration. Do not compare a 30-second import sample with a 120-second populated
viewer. Alternate or shuffle mode order with a recorded seed, repeat before
claiming small differences, and never keep earlier subjects alive: simultaneous
copies would change file-page PSS sharing.

At the target age, the external runner captures full `/proc/PID/smaps`,
`smaps_rollup`, maps and status, with collection timestamps. Then request one
`process.memoryUsage()` and `bun:jsc.heapStats()` record from the subject and
terminate it after acknowledgement. Capture the primary OS measurements before
the heap walk. Local Bun type documentation says `heapStats()` walks the entire
heap; `heapSize`/`objectCount` describe the most recent collection, while
`objectTypeCounts` include currently allocated cells. Therefore the unforced
heap counts are descriptive allocation evidence, not exact live ownership.
Do not use `Bun.gc`, `fullGC`, heap snapshots or an allocator purge in ordinary
measurements. A separately labeled forced-GC diagnostic may follow later, but
must not replace the ordinary values.

Store full raw mappings before deriving grouped sums: anonymous, executable,
terminal DSO, system DSO and other named mappings. Report RSS, PSS and private bytes
together. Anonymous pages can include JS, JIT, allocator reserves and native
heaps; their presence alone does not distinguish those owners. Mapped bytes and
on-disk file sizes are not resident-byte attribution. Page sharing with other
host processes remains a limitation, so retain mapping identities and host
context rather than labeling all file PSS as a private runtime cost.

Suggested scope is three benchmark-only files: a subject entrypoint, a compact
builder mirroring the production compile options, and an external serial runner
that captures raw records and writes a manifest. No production import refactor,
GC change, eviction policy or native allocation instrumentation is required for
this first experiment. Those changes should follow the measured boundaries.


## Harness and frozen inputs

`viewer_memory_subject.ts`, `viewer_memory_build.ts`, and `viewer_memory.py`
implement the proposed initialized-state ladder. These are benchmark-only files;
no production import, GC, allocator, or eviction policy changed. Formatting,
focused type checking, builds, fixture verification and the first age30 sweep
have passed; see `viewer_memory_findings.md` for results and exact provenance.

The builder requires an independently frozen source tree and exact four-file
native directory. It checks the production `{src,assets}` hash, combined native
hash and Bun version against a production `.build.json` before compiling. It
rewrites only the subject's application import paths to the supplied source tree;
it does not import the current mutable workspace's application modules. Every
ladder mode runs the same compiled subject. The separately compiled tiny control
uses the identical wait/statistics shim with the application-mode implementation
removed. Native assets and the two worker entrypoints match production for the
main subject; the tiny control intentionally has neither.

The frozen V14 inputs are now prepared, without any build or application run:

- Source: `/tmp/v14-memory-source-frozen-20261026`, made from baseline
  `fb129d2ef96511a3c727112e0d1df2191bb5b241` plus the exact V14 source overlay.
- Native: `/tmp/v14-memory-native-frozen-20261026`, copied from the archived V14
  native directory rather than the mutable workspace build output.
- The 594 source/asset files hash to
  `599711dca842026e815c47f6219280ec98e2163af90f2702cf7fca2e90563a93`.
  The four native files hash to
  `f47eecce50af1f1f0130dbf484165706639f8c04cc74532859555b00acf48cac`.
  Both match `dist/corgi-retained-v14.build.json`.
- `dist/retained-v14-memory-inputs.json` records the archive and individual-file
  hashes, baseline, dependency symlinks and verification. Its SHA256 is
  `1d61b0fe18401aa46d9d8086fc2b79e973d6bd1384d66c12bb53171d19f43544`.

Commands for a future granted CPU slot:

```sh
bun tools/benchmarks/viewer_memory_build.ts --source /tmp/v14-memory-source-frozen-20261026 --native-root /tmp/v14-memory-native-frozen-20261026 --reference dist/corgi-retained-v14.build.json --out /tmp/viewer-memory-v14-build
python3 -B tools/benchmarks/viewer_memory.py /tmp/viewer-memory-v14-build /tmp/viewer-memory-v14-verify --verify-only
python3 -B tools/benchmarks/viewer_memory.py /tmp/viewer-memory-v14-build /tmp/viewer-memory-v14-age30 --age 30 --repeats 3 --node 0 --cpus 8-15
```

The runner produces the canonical surface in a separate setup process, thereby
pre-extracting embedded assets before measured subjects. Independent verification
processes compare retained output with a full-frame terminal and check initialized
mirror counts (0/1/1/16). The final sixteen-pane metadata and visited screens must
match exactly. The one-pane case has the same focused pane contents but naturally
has fewer sidebar entries. No producer VT or corpus is kept in measured subjects.

Each subject is a fresh process; no previous subject remains alive when the next
starts. Mode order is shuffled with a recorded seed. The runner owns the existing
CPU lock and stays on CPU0; subjects use explicit NUMA CPU/memory placement. It
checks executable/native hashes, absence of native mappings in empty controls,
CPU affinity and absence of child processes. It captures smaps, rollup, maps,
status, numa_maps and stat before requesting one ordinary memoryUsage/heapStats
record, then closes the owned subject. Separate raw mappings, heap records,
launch/setup/age times, host process context and hashes are retained. There are
no forced collections. An actual steady-viewer reference is still needed before
attributing any residual production gap to imports or Bun itself.

Source review tightened the following boundaries before execution:

- The long-lived cleanup closure is created outside the fixture setup function.
  It owns the Controller and Differ, not the setup scope containing intermediate
  frames, verification output or parsed fixture inputs. Module caches and the UI's
  own retained frames remain part of the intended initialized state.
- The initialized-mirror check first verifies that the frozen mirror still has
  its expected allocation field. It cannot silently report success if that field
  changes. The Differ's separate host VT is present in every Controller case.
- Initial sidebar rows do not animate unless marked reopened; this fixture has
  no restored panes. The subject asserts that row transitions are settled before
  readiness rather than adding unequal artificial redraw histories. Separate
  verification processes must still prove metadata16/visited16 screen equality.
- The native-binding stage includes the bindings' actual JS module globals and
  scratch buffers, not only mapped DSOs. In V14 those dependencies include the
  process-argument scratch buffer and native JSON reply buffer. Requested buffer
  capacity does not establish resident bytes.
- Native/source hashes are checked before and after compilation. Builder,
  subject, production build script, dependency manifests and frozen-input receipt
  are copied into the build output. The runner saves its own exact source and
  every thread's observed affinity, and records the age of each OS capture.
- Ordinary aging can retain dead initialization allocations until a normal GC.
  The visited-minus-metadata difference therefore describes an initialized,
  quiescent process, not an exact sum of live native VT allocations. No forced
  collection is introduced to make that difference look cleaner.

The first validation checked compiled dynamic-import behavior, initialization
counts, unexpected RPCs, screen parity, clean shutdown and native-map identities
before the measured sweep. Its 24 ordinary subjects completed without forced GC.
