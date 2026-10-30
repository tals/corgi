# Compiled Bun bytecode and splitting audit

Source-only; no new build, test, or memory measurement. Examined Corgi's current
`build.ts` and Bun revision `38afee6c84fcf48c0edb2466aa4b27d287a59c30` at
`/home/t/dev/vendor/bun-corgi-boundaries-20261026`.

## Recommendation

Measure one benchmark-only variant of the frozen V14 memory subject with these
three additional `Bun.build` options:

```ts
bytecode: true,
splitting: true,
format: "esm",
```

Keep the existing three entrypoints, native assets, plugins, source tree,
release constants, Bun executable, GC defaults and application fixture exact.
Do not minify identifiers, add bytecode order hints, or modify production build
settings during the experiment. This combined variant tests whether bundling
and bytecode ownership explain meaningful initialized private memory. It does
not separately attribute splitting versus bytecode; a factorial is unnecessary
unless the combined result warrants further work.

The API combination is supported in this Bun, but is not yet proven a drop-in
production change for Corgi. In particular, the two real workers and production
relative paths need validation beyond the memory subject.

## Source evidence

Bun's `src/runtime/api/JSBundler.rs:659–666` changes the default output format to
CJS when `bytecode` is true. The explicit `format: "esm"` is therefore required;
simply adding `bytecode: true` is a different experiment. The format parser
accepts ESM/CJS at `:874–895`, and `:1390–1395` explicitly permits ESM bytecode
only when compiling an executable.

`test/bundler/bundler_compile_splitting.test.ts:92–159` exercises compiled ESM
with and without bytecode across static cycles, builtins, overlapping dynamic
imports and lazy shared chunks. The bytecode variant records fewer loader host
fetch/resolve calls. `:396–420` tests `import.meta.url` and `import.meta.dir` in
a split chunk. `:680–701` covers a split multi-entry bundle whose worker and
main thread enter a shared cyclic graph independently; that particular worker
case does not enable bytecode, so it is not proof of Corgi's full combination.

`test/bundler/bun-build-compile.test.ts:68–142` compares mapped executable
bytecode with bytecode loaded from owned on-disk buffers. Its generated fixture
checks that decoded instruction streams alias the executable mapping instead
of being copied into anonymous memory. This is a concrete ownership mechanism,
not a prediction that Corgi will save the same amount. The test's thousands of
functions and executed code differ from the mostly idle viewer.

`bun-build-compile.test.ts:1826–1858` covers embedded file assets alongside
compiled ESM, splitting and bytecode, including a chunk whose bytecode cannot
be generated. Asset bytes remain available through their bundled paths.
Thus Corgi's `with {type:"file"}` native imports do not inherently require
external chunk files or a new native extraction mechanism.

## Corgi-specific boundaries

`build.ts:102–124` currently has main plus Codex-index and resource-sampler
worker entrypoints, `target: "bun"`, the compile target and two plugin-provided
modules. Dynamic imports in `src/main.ts` separate server, viewer/client,
handoff, import and diagnostic paths. Splitting can keep unrelated chunks out
of an entry's loaded closure; shared dependencies still load normally. It does
not remove modules genuinely needed by the viewer.

The worker factories at `src/providers/codex/files.ts:50–52` and
`src/trackers/resources.ts:532–534` construct URLs relative to `import.meta.url`
and explicitly assume the compiled module uses the main entrypoint's directory.
Bun's default split chunks are `/$bunfs/root/chunk-*.js`
(`bundler_compile_splitting.test.ts:350–357`), so the existing relative worker
paths appear compatible with the production three-entry layout. This remains
an inference: validate both real factories, their returned data and their
cleanup. Do not infer worker compatibility from successful viewer startup.

The memory builder places its subject entry outside the frozen source tree.
That can give its embedded entrypoint paths a different common root than
production. Its modes intentionally do not start those workers. Keep its
source/entrypoints unchanged for the memory comparison, and use a separate
production-shaped smoke build for worker/path validation if the result is worth
pursuing. Avoid changing fixture layout just to make a worker smoke pass.

Other inspected path uses are compatible in principle: `build_id.ts` and the
headless launcher recognize the `/$bunfs/` prefix rather than one entry filename;
native extraction uses embedded asset values and the native content hash.
Still validate discovery/self-relaunch and extracted native hashes in a real
compiled candidate. The build manifest's input hash currently omits bundler
options (`build.ts:87–90`); a future production change must include them so
build-time reuse and provenance do not conflate old and new builds.

## Cross-compilation limits

The API allows bytecode with another OS/architecture. The pinned tests at
`bun-build-compile.test.ts:1860–1947` cover cross-target flags and target builtin
sources, but run with the host executable substituted as the target. They do
not execute a genuine macOS ARM64 or macOS x64 Corgi binary on this Linux host.

`src/exe_format/builtins.rs:1–9` reads target ELF/Mach-O/PE builtin sections.
`src/standalone_graph/StandaloneModuleGraph.rs:2869–2907` skips builtin bytecode
when an older/unrecognized target lacks a readable section; malformed sections
are errors. `src/bundler/linker_context/generateChunksInParallel.rs:1747–1765`
also skips internal-module bytecode when the target's engine stamp differs from
the host compiler. A cross build can therefore succeed without the same builtin
bytecode benefits measured locally. Record the exact target runtime and check
cache-hit diagnostics separately on each release platform before adopting it.

## Minimal measurement and acceptance

Add an explicit opt-in to the benchmark builder only, keep its default exactly
reproducible, and record the three options in its manifest. Use a new output
directory and preserve the existing baseline. First compare fresh processes in
`empty`, `viewer`, and `metadata16` modes with the same frozen surface fixture
and the existing initialized-state/parity checks. Extend to `visited16` only if
useful. Report private/anonymous memory, PSS, RSS, file-backed mappings, binary
size and startup separately: shifting instructions into shared executable pages
can reduce private memory without the same reduction in total resident pages.

One diagnostic invocation may enable `BUN_JSC_verboseDiskCache=1` to establish
that the relevant chunks hit embedded bytecode; do not enable verbose output
during memory/startup timing. No forced GC or allocator settings should be added.
Build time is setup cost and should be reported separately from installed
startup. Any production adoption then needs actual worker exercises, existing
native/TS correctness, integrations, visual parity and release-platform checks.


## Prepared measurement controls

The benchmark builder now accepts `--bytecode-split` and records the exact
`{ bytecode: true, splitting: true, format: "esm" }` options and variant name.
Its default preserves the original compilation behavior. The memory runner
accepts `--modes empty viewer metadata16`; it still verifies all eight modes
before measuring the selected subset. Both changes are source-only and await
format/type validation and execution in the exclusive CPU slot.

The planned first comparison uses the existing frozen V14 source/native inputs,
new output directories, 30 seconds after readiness, three repeats per selected
mode, NUMA node 0 and CPUs 40–47. It compares the same initialized states with the
completed ordinary-build ladder. It does not claim startup or steady CPU gains
from bytecode, and cannot separately attribute splitting versus bytecode.

```sh
bun tools/benchmarks/viewer_memory_build.ts --source /tmp/v14-memory-source-frozen-20261026 --native-root /tmp/v14-memory-native-frozen-20261026 --reference dist/corgi-retained-v14.build.json --out /tmp/viewer-memory-v14-bytecode-split --bytecode-split
python3 -B tools/benchmarks/viewer_memory.py /tmp/viewer-memory-v14-bytecode-split dist/viewer-memory-v14-bytecode-split-age30 --age 30 --repeats 3 --node 0 --cpus 40-47 --modes empty viewer metadata16
```
