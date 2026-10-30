# Production PTY reader experiment (V16, rejected for adoption)

V16 passes correctness and visual validation, but the controlled whole-app runs
do not demonstrate a meaningful CPU gain over V15. Reject production adoption
of this added ownership/concurrency machinery; preserve the frozen candidate,
source and results as an experiment. The actor prototype's 30.7% staggered
component gain did not transfer to the production workload.

## Whole-app result

Each row is one accepted directional pair on the same NUMA node 0, CPUs 40–47,
with 16 providers, matched 132×47 geometry, default product features, 120-second
streaming warmup and 60-second sample. CPU percentages use one core = 100% and
exclude providers. V15 ran before Herdr; V16 ran after a fresh Herdr reference.

| Schedule / candidate | Corgi daemon | Corgi viewer | Corgi total | Fresh Herdr total | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aligned / V15 | 4.283% | 1.800% | 6.083% | 3.617% | 1.682× |
| Aligned / V16 | 4.133% | 1.817% | 5.950% | 3.400% | 1.750× |
| Staggered / V15 | 4.967% | 1.667% | 6.633% | 3.817% | 1.738× |
| Staggered / V16 | 4.900% | 1.683% | 6.583% | 3.383% | 1.946× |

V16's sequential total differences are only −0.133 and −0.050 percentage points.
The repeated Herdr reference moved by −0.217 and −0.433 points respectively;
these single pairs do not isolate a candidate effect or establish confidence
intervals. All four V16/reference trials passed on their first attempt. The
earlier V15 staggered noise rejection remains excluded and preserved. Every
accepted controlled window had 19,168 interior writes and zero dropped deadlines;
pane cadence remained 20 Hz and Corgi's informative spinner remained 12.3–12.7 Hz.
Post-window V16 daemon/viewer PSS was 91.74/67.83 MiB aligned and 89.38/65.88 MiB
staggered, versus approximately 20.3/9.0 MiB for Herdr.

The staggered thread breakdown shows work moving rather than disappearing:

| Daemon thread group | V15 | V16 |
| --- | ---: | ---: |
| Main | 2.842% | 2.050% |
| General readiness | 0.723% | 0.050% |
| Native PTY reader | — | 1.428% |
| Sum of those groups | 3.565% | 3.528% |

V16 reader system CPU alone is 1.294%, while main system CPU fell from 1.194%
to 0.773%. The aligned group subtotal similarly changes only 2.863%→2.789%.
Thread samples use inner half-second boundaries, so they are not exact process
CPU partitions. Raw process/thread user and system counters remain available.

The component's 5.017% old-path result includes all consumer threads, not just
main plus readiness; compare that with V15's full 4.967% daemon, not its 3.565%
thread subtotal. The prototype sampled main+readiness subtotal was 4.455%,
falling to 3.205% main+actor; production had substantially less old-path work to
remove. Its corpus also differs: fixed 256-byte records exercise Unicode,
colors, changing titles, clipboard, links, mode changes, scrolling and replies;
the product sparse fixture writes approximately 140 ASCII/positioning bytes.
Prototype counters, a 10/30-second warm/sample window, a different L3 placement
and a colocated native producer further limit direct transfer of its percentage.

Source review finds no recurring duplicate PTY drain in V16 maintenance:
`Server.collect` calls `maintain()`, while explicit `read()` is for lifecycle
operations. Hidden notifications are deferred by the intended viewer-interest
policy. The production reader uses `poll` over every registered descriptor,
where the prototype uses `epoll`; V16 also adds registry/lifetime synchronization.
Those are plausible overhead sources, not measured syscall attribution. No V16
notification/poll/futex counters were captured in these clean runs. A new backend
experiment is not needed to justify rejecting the present candidate.

Combined summaries are `dist/producer-phase-product-summary.json` (V15) and
`dist/producer-phase-v16-summary.json` (V16). Raw output, native identity checks,
producer traces, thread summaries and artifact manifests are linked from
`dist/retained-v{15,16}-herdr-controlled-{aligned,staggered}/`.

The production candidate uses one POSIX poll worker rather than the prototype's
Linux epoll worker. It reads directly into native stack storage and feeds the
existing opaque terminal. Bun chooses which panes notify immediately; hidden
output receipts wait for the existing 50 ms daemon maintenance tick. Errors and
hangups always notify immediately. Promotion of a hidden pane delivers any
pending receipt without waiting for further output.

This removes the PTY read buffer, drain loop and readiness rearming from Bun.
It does not move composition, screen interpretation, provider decisions or UI
policy into native code. There is no cell hashing or second terminal model.
Native entrypoint guards, copied title-response ownership, synchronous detach,
and pending-input readiness are the new ownership machinery. Unlike Herdr's
per-pane actors, a single worker serializes parsing across panes; a large image
decode can delay another pane even with the bounded input-byte slice.

Review found several assumptions that depended on Bun owning all reads:

- Buffer-size discovery and retry can now observe different response lengths.
  The JSON boundary retries with bounded geometric buffer growth.
- An observation receipt must precede its screen read, so output arriving during
  interpretation remains eligible for the next pass.
- Restored ghost screens and cold-recovery journals must be initialized before
  the read owner starts. Child startup output must never be cleared afterward.
- A final process-ending marker follows synchronous reader detach.
- Detach returns already-consumed output, including receipts copied into a Bun
  batch but not yet dispatched. Dispatch is bounded and native pagination fair.
- A readiness collection can invoke callbacks; a manual drain rechecks terminal
  lifetime before entering native code.

The first pinned ReleaseFast native build passes 60 tests, including seven new
reader lifecycle/concurrency tests. Initial focused TypeScript validation passed
34 of 35 tests; the new title fixture exceeded Ghostty's title-length limit.
After reducing that fixture below the limit, all 35 pass. These checks predate
the subsequent startup, JSON-growth and observation-receipt regression tests.
The subsequent full run passes 1,946 tests with one opt-in skip. Its first run
exposed two fake runtimes that omitted the new initializer, and a PTY test that
waited for parsed bytes instead of the separate Bun notification; those fixtures
now follow the actual ownership contract. Format/typecheck and production,
integration-test-binary and browser builds pass. Failed logs are preserved.

V16 is frozen as `dist/corgi-retained-v16`, SHA-256
`ef83d58431394dc6211da8a960d427a74d841b4edab00727a03ca6c984c8b996`.
Its source/native manifests and overlay archive are
`dist/retained-v16-source.{json,tar.gz}`; native assets are independently frozen
in `dist/retained-native-v16`. All seven integration suites pass on their first
run: 109 cases, with two platform skips. The settled visual comparison matches
all 19 states in styled cells, cursor, links, image pixels and PNG hashes under
`dist/retained-visual-v16-settled`; selection, dimmed-dialog and split-pane PNGs
were also visually inspected.

The first visual run is retained under `dist/retained-visual-v16`. Eighteen
states matched; the sparse state's eight differing cells were in the tab title,
where one process-discovery result had arrived and the other had not. The
fixture now waits for the same visible process title in both products before
the first capture. No product change or screenshot normalization was made.
The product timings above use the shared producer fixture with a common
monotonic-clock epoch and explicit aligned/staggered phases. Historical Corgi/
Herdr ratios had uncontrolled producer phases; they remain valid descriptions
of those observed runs, but cannot establish a phase-controlled comparison.
