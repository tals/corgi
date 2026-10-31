# Initialized viewer memory ladder

The first controlled ladder separates bundle/import costs from initialized pane
state. Fifteen additional hidden pane records cost about 0.66 MiB PSS while
their native terminals remain uninitialized. After visiting those panes, the
same final visible UI retains another 13.68 MiB. This is a meaningful target for
releasing inactive native mirrors, subject to reconstruction and selection
correctness. It is not an exact sum of native allocations or proof the allocator
will return all those pages immediately after eviction.

The small compiled Bun control uses 17.53 MiB PSS. Merely running the larger
application-containing executable, without importing its application modules or
loading its native libraries, uses 28.49 MiB. Evaluating the viewer dependency
graph adds another 7.88 MiB over the native-binding stage. The whole viewer
memory difference therefore cannot be described as an unavoidable empty Bun
baseline.

## Results

Values are MiB, medians of three fresh processes per mode, at thirty seconds
after readiness. All seven application modes use the identical compiled binary;
the tiny control is a separate binary with the same waiting/statistics shim.
Private is Private_Clean + Private_Dirty + Private_Hugetlb from smaps_rollup.

| Mode | RSS | PSS | PSS range | Private | Anonymous |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tiny compiled waiting control | 19.94 | 17.53 | 17.40–17.53 | 17.51 | 4.10 |
| Application bundle, no imports | 30.93 | 28.49 | 28.42–28.51 | 28.47 | 8.87 |
| Native bindings, no terminals | 33.58 | 31.17 | 31.16–31.17 | 31.15 | 9.19 |
| Viewer import, no Controller | 41.49 | 39.05 | 39.00–39.11 | 39.03 | 12.90 |
| Controller, zero panes | 47.00 | 44.57 | 44.51–44.59 | 44.56 | 16.44 |
| One initialized visible pane | 49.04 | 46.62 | 46.59–46.71 | 46.60 | 17.86 |
| Sixteen pane records, one initialized | 49.73 | 47.28 | 47.10–47.29 | 47.26 | 18.52 |
| Sixteen visited panes, focus back on one | 63.37 | 60.96 | 60.93–60.98 | 60.95 | 30.58 |

The important contrasts are:

- Large bundle versus tiny control: +10.97 MiB PSS, including +4.77 MiB
  anonymous and +6.20 MiB executable-mapping PSS. Empty controls mapped neither
  application DSO. This measures bundle residency and its initialized runtime
  representation; it does not identify a specific unused provider import.
- Native binding initialization: +2.67 MiB PSS. Only about 0.48 MiB is mapped
  application DSO PSS at this stage; another 2.00 MiB is newly touched executable
  mapping. A DSO's on-disk size is not its resident cost.
- Viewer dependency evaluation: +7.88 MiB PSS, with +3.71 MiB anonymous and
  +4.19 MiB executable-mapping PSS. Narrower imports may help, but this does not
  assign those bytes to individual modules.
- Empty Controller/host/drawing state: +5.53 MiB PSS. The terminal/system DSOs
  together reach about 2.01 MiB PSS as rendering actually exercises them.
- First populated mirror: +2.04 MiB PSS. Fifteen additional metadata-only panes
  add only +0.66 MiB, so eager native allocation has already been avoided.
- Visiting the fifteen extra panes: +13.68 MiB PSS, including +12.06 MiB
  anonymous and +1.63 MiB executable mapping. It also executes more focus/render
  code and leaves normal allocation history, so division by fifteen is an
  initialized-process slope, not a native object size.

`cpu.ts`'s geometry setup visits all sixteen agent tabs before measuring. Its
steady viewer should therefore be compared to the visited16 control, not the
metadata16 control. An approximately 69 MiB PSS production observation versus
this 60.96 MiB initialized control is still not a matched causal estimate of
polling/JIT/JSON cost: the executable entrypoints, active workload and measurement
age differ. The ladder's direct comparisons are between its own controlled modes.

## Heap observations and limits

The runner captured OS mappings first, then requested the ordinary Bun memory
and JSC heap statistics. Heap statistics are descriptive; they do not establish
exact live ownership, and extraMemorySize must not simply be added to RSS or
interpreted as native VT bytes.

| Mode | JSC heapSize MiB | extraMemorySize MiB |
| --- | ---: | ---: |
| Tiny | 1.17 | 0.55 |
| Empty application bundle | 3.01 | 0.91 |
| Native | 4.15 | 2.00 |
| Viewer import | 5.28 | 2.45 |
| Controller, zero panes | 7.17 | 4.03 |
| One initialized pane | 7.47 | 4.21 |
| Sixteen metadata panes | 7.64 | 4.33 |
| Sixteen visited panes | 8.55 | 5.20 |

The much larger anonymous/PSS rise after visiting panes than the reported heap
rise supports investigating native surfaces and allocator retention. It does
not distinguish individual native structures from allocator/JIT effects. No GC,
allocator purge or heap snapshot was forced. Dead setup allocations could remain
until ordinary collection; heap diagnostics themselves were deliberately last.
The subject retains Controller/Differ through a cleanup closure created outside
setup, rather than accidentally retaining every intermediate frame/input corpus.

No PTYs, daemon or provider processes exist in these subjects. There is no
animation, sustained input, network traffic, worker sampling or model call.
Review summary read-ahead is the only disabled RPC behavior; unexpected transport
calls fail. The first empty Controller frame includes its separate host VT and
render state. All populated modes use one separately prepared canonical surface,
parsed separately for each visited pane, with styled wide/combining text.

## Validation, placement and provenance

Formatting, focused TypeScript checking and both production-style Bun builds
passed. An initial TypeScript control-flow complaint about a frame assigned
inside a draw callback was fixed with a local type assertion; its first unused
build and logs were preserved. The measured build is
`/tmp/viewer-memory-v14-build-validated`.

Eight separate verification processes passed full-frame versus retained-output
surface parity. Metadata16 and visited16 finish with exactly the same visible
screen. Mirror initialization counts were explicitly checked as 0/1/1/16 for
controller0/pane1/metadata16/visited16. A separate 0.1-second preflight exercised
the OS/heap collection and map checks; its values are not in the table above.

All 24 ordinary measurement subjects passed executable/native hash checks,
requested CPU affinity on every thread, absence of child processes, and clean
shutdown. No owned measurement PID remained afterward. Mode order was shuffled
with seed 20261026, three repeats, one process alive at a time. Subjects ran on
CPUs 40–47 with NUMA memory policy bound to node 0; the observer ran on CPU 0.
Full smaps captures began 30.0006–30.0016 seconds after readiness. Full smaps,
rollup, maps, status, numa_maps and stat precede heap requests. No CPU ranking is
inferred from this memory experiment.

The exact source, four native assets and compiled subjects were reverified after
the sweep. Frozen V14 inputs were independent of the active worktree's later
V16-to-V15 restoration.

- Product source SHA256: `599711dca842026e815c47f6219280ec98e2163af90f2702cf7fca2e90563a93`
- Four native assets SHA256: `f47eecce50af1f1f0130dbf484165706639f8c04cc74532859555b00acf48cac`
- Main subject SHA256: `eb84cedb5ebfd5d10c6ddd78a1c43c30efaf749cf43d66732b4259390561491f`
- Tiny control SHA256: `68836a0ac7987cde51b7fa185cc614b090c9f3d21bb613f68b9d59194c72abe5`
- Raw manifest SHA256: `502b7d7ab47da9ac4786cfeb3c14527c25aa6646184a5b24f89c6ac2302f9ea9`

Raw measurements and the analysis are in `dist/viewer-memory-v14-age30/`;
verification/preflight are in `dist/viewer-memory-v14-{verify,preflight}/`.
Validation/build logs and the analysis script are in
`dist/viewer-memory-v14-validation/`. The build receipt and archived subject,
builder, production build script and dependency manifests preserve the inputs.
File-page PSS can still depend on unrelated processes sharing mapped files; raw
mapping identities and host context are retained to expose that limitation.
