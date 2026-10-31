# Existing-run scheduling and topology audit

This is a read-only audit of the accepted V11 Corgi/Herdr ABBA block and the
accepted V12 Corgi-only run. It launches no workload and changes no application
affinity. The raw calculation and source hashes are in
`dist/thread-topology-v11-v12.json`; its reproducible analysis script is
`dist/thread_topology_audit.py`.

## Placement

The host has two AMD EPYC 7C13 sockets, each with 64 physical cores and two
hardware threads per core: 128 cores, 256 logical CPUs, two NUMA nodes.

The benchmark's CPUs 8–15 are eight distinct physical cores in socket/NUMA node
0. All eight share L3 cache ID 1, a 32 MiB cache; each core has its own 32 KiB
L1 data cache, 32 KiB L1 instruction cache and 512 KiB L2. Their SMT siblings
136–143 share those private caches and are excluded from benchmark affinity.
The node-1 placement, CPUs 72–79, similarly shares one 32 MiB L3 (ID 9), with
SMT siblings 200–207. Sysfs cache and topology values are saved in the JSON.

Every sampled application thread in these five accepted runs last executed
inside CPUs 8–15. There is no observed cross-L3, cross-socket or cross-NUMA CPU
execution. The launch command also uses `--membind=0`; that records an allocation
policy, not proof that every mapped file/cache page or kernel allocation is
local. No historical per-page NUMA placement was recorded.

## Observed CPU changes

Each row below is approximately 59.3–59.6 seconds inside a 60-second CPU window,
with 115–116 samples. Counts are changes in a thread's last-executed CPU between
adjacent observations, not kernel migration counters.

| Accepted run | Daemon main CPU changes | Viewer main CPU changes | Adjacent observations |
| --- | ---: | ---: | ---: |
| V11 Corgi, first | 53 | 43 | 114 |
| V11 Herdr, first | 75 | 41 | 114 |
| V11 Herdr, second | 38 | 42 | 115 |
| V11 Corgi, second | 26 | 30 | 114 |
| V12 Corgi | 58 | 50 | 114 |

Corgi's viewer does not consistently change CPU more often than Herdr's in
these observations. V12 has more observed changes than either V11 Corgi viewer
run while using less viewer CPU. This does not exclude private-cache or wakeup
cost, but does not support attributing the Corgi-specific gap to migration.
The eight-core allowance permits cross-core scheduling within one shared L3;
these samples do not identify who woke whom or count cross-core wakeups.

## Thread inventory and recorded work

"Active" means at least one CPU tick was recorded between adjacent observations.
A zero-tick thread can still have performed work below timer granularity.
"Resident" is the range of thread counts seen in individual samples; transient
threads can make the number of distinct IDs seen across the window larger.

| Product/process | Resident threads | Distinct IDs seen | Active IDs | Main CPU | Helper CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| V11 Corgi daemon | 18–21 | 22–24 | 16–18 | 3.17–3.26% | 1.89% |
| V11 Corgi viewer | 11–14 | 15–18 | 9 | 1.36–1.43% | 0.54–0.56% |
| V11 Herdr daemon | 46 | 46 | 24–26 | 0.44–0.46% | 2.48–2.85% |
| V11 Herdr viewer | 7 | 7 | 3 | 0.10–0.12% | 0.08–0.10% |
| V12 Corgi daemon | 20–22 | 24 | 19 | 2.86% | 1.85% |
| V12 Corgi viewer | 11–14 | 19 | 6 | 1.29% | 0.37% |

CPU is user plus system time, with 100% representing one core. These thread
sums use the inner sample window and rounded kernel ticks, so they differ
slightly from the separately timed process CPU windows.

The V11 Corgi viewer records about 0.219% CPU in JIT workers, 0.118% across seven
heap helpers, and 0.202–0.203% in the scavenger. Several additional JIT thread
IDs appear during the window, but only one records CPU ticks. V12 records
0.134%, 0.050%, and 0.185% respectively. In Herdr's viewer, the endpoint reader
records about 0.067%; one of three additional threads sharing the executable's
name records 0.017–0.034%. The endpoint writer and signal thread record no ticks.

Using the V11 thread windows consistently, approximately three quarters of the
viewer CPU difference is on the main threads and one quarter on helpers. Neither
category is a JavaScript-only measurement: native routines, syscalls and runtime
work all accrue to the executing thread. Names identify components, not stacks.

Corgi's daemon records two `corgi-fd-ready` threads at a combined 0.438–0.557%,
a `Worker` at 0.523–0.539%, JIT at 0.236%, heap helpers at 0.152–0.202%, and
scavenging at 0.287–0.320%. Bun pool threads add 0.101–0.118%. Herdr's daemon has
more resident threads despite lower process CPU: 25 `tokio-rt-worker` threads,
of which five to seven record ticks, total 1.63–1.94%; its 17 PTY threads total
0.81–0.86%, with 16 recording ticks. Thread count alone therefore does not
explain Corgi's higher cost.

## Limits and next decision

The observer sleeps 500 ms between collections; actual adjacent sample spacing
is slightly longer. A thread can migrate multiple times, or return to its old
CPU, between samples. The observed changes are only a lower bound. The last CPU
is retained while a thread sleeps, so equal or different CPU labels do not prove
simultaneous execution or an actual IPC/wakeup pairing. Ten-millisecond tick
resolution and unobserved transient threads further limit attribution.

The V11 numbers come from one accepted ABBA block on one NUMA node; V12 is a
later Corgi-only run. Rejected noisy attempts and profiled diagnostics are not
included. This audit does not estimate migration overhead, cache misses,
context-switch cost or user-versus-kernel CPU. It does not justify a new affinity
experiment yet. Await the V14 process user/system breakdown before choosing a
scheduler sensitivity test or attributing remaining main-thread cost to JS.
