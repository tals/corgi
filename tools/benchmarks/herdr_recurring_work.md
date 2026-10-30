# Recurring daemon work: source audit

This audit compares frozen Corgi V14 with the pinned Herdr v0.9.5 source tag
`2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`. Rates below are derived from the code
and the sixteen-agent, 20 Hz streaming fixture; they are not syscall measurements.
Existing V12 telemetry supplies wall-duration ceilings, not additive CPU
attribution for V14. No production changes or new timing runs were made for
this audit.

## PTY ownership hypothesis: subsequently rejected

The source comparison below motivated V16, which passed correctness and visual
validation but did not produce a meaningful whole-application CPU improvement
on either controlled producer phase. Production reverted to the V15 reader.
The component prototype overstated the old-path production cost; moving parsing
into a native thread mostly moved main-thread work into worker work. This
mechanism is not a pending adoption recommendation. See
[the completed experiment](pty_reader_findings.md).

### Source comparison behind the experiment

Corgi's readiness reporter waits for descriptors, sends token/event records to
Bun, and rearms one-shot readiness after the JS callback drains the PTY. The
drain reads bytes into a reused 64 KiB Buffer, feeds Ghostty through FFI and reads
again until EAGAIN or its fairness bound. Sixteen 20 Hz streams produce roughly
320 readiness deliveries, positive reads, empty reads, feed calls and rearms per
second when each update is one kernel chunk. Those counts need the syscall
diagnostic to confirm; a write is not guaranteed to equal one read. See
[terminal callback and drain](../../src/pane/terminal.ts:186) and
[native readiness](../../native/readiness.c:24).

Herdr starts one native actor thread per Unix pane. Its actor polls the PTY and
a control wake descriptor, reads once into 8 KiB, then invokes the terminal parser
on the same thread. It does not forward each readiness record to another
language runtime or rearm EPOLLONESHOT. The parser emits typed title/CWD changes
and coalesced render-dirty pane identities. Hidden-only dirty sets can be
discarded before rendering. See
[actor creation](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pty/actor/unix.rs:433),
[poll/read loop](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pty/actor/unix.rs:541),
[read and parser callback](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pty/actor/unix.rs:823),
[PTY processing](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane.rs:2784),
and [hidden-source classification](/home/t/dev/personal/herdr-cpu-benchmark/source/src/server/headless.rs:543).

Corgi already avoids waking a viewer solely because an unobserved pane printed:
its wake sequence includes watched surface revisions. It still evaluates that
eligibility on each output event. This is narrower than a claim that every
hidden event redraws Corgi's viewer. See [wake sequence](../../src/server.ts:143).
The original equivalent experiment targeted reducing the PTY transport/ownership hops,
while preserving output, fairness, writes, close and handoff behavior. Merely
moving parsing onto a native thread would require explicit terminal ownership
or synchronization; current mutable terminal handles cannot be shared casually.

## Process discovery buys different freshness

| Recurring work | Corgi, sixteen active panes | Herdr, sixteen identified panes |
| --- | --- | --- |
| Foreground group observation | About 64 `tcgetpgrp` calls/s | About 53.3 shell `/proc/PID/stat` reads/s at 300 ms |
| Full foreground job identification | About 64 pane checks/s at 250 ms | Group changes plus 5 s safety: about 3.2 checks/s if no authoritative lifecycle suppression |
| Common shell-plus-agent fixture argv | About 128 distinct cmdline acquisitions/s | Full-probe dependent; not inferred as one argv read per check |
| Known child group validation | About 64 scalar `getpgid` calls/s | Part of its differently structured job/identity observations |

Corgi's current foreground path is
[observer scheduling](../../src/observer_service.ts:373) →
[shared foreground collection](../../src/detection.ts:187) →
[argv acquisition](../../src/os.ts:126). The retained V14 scene reports `sh` as
the foreground program and recognizes the agent child in that group. It reads
the leader's argv, checks the known child's group, then reads that child's argv.
Each cmdline acquisition opens the proc file, reads through EOF and closes it.
The 1 MiB scratch Buffer is reused; it is not allocated on every probe. Returned
strings, split arrays, views and result objects are still created each time.

Herdr observes the foreground group each ordinary identified tick but runs the
full job probe only on initial acquisition, group changes, specific pending
states, or the 5 s identified-agent safety interval. With authoritative lifecycle
evidence and a stable group, it can skip that safety probe too. Its full probe
can reread leader/group information and inspect several processes; its advantage
is principally fewer full probes, not necessarily cheaper individual probes.
See [intervals and decisions](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane.rs:413),
[lifecycle suppression](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane.rs:648),
[normal detection tick](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane.rs:2851),
[group observation](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane.rs:2987),
and [Linux group read](/home/t/dev/personal/herdr-cpu-benchmark/source/src/platform/linux.rs:651).

Reducing Corgi's full probe cadence to 5 s would delay detection of an exec or argv
change under the same PID/group, and potentially agent replacement and displayed
program changes. It is a behavior tradeoff, not an equivalent optimization.
Likewise, replacing live process identity checks with lifecycle authority changes
how missing or stale hooks are handled.

There is no common duplicate argv acquisition inside one Corgi 250 ms pass:
`detectPane` receives the observed job or explicit null and does not probe again.
Groups shared by terminals are already read once per collection. A narrow
duplicate exists when the previously known child no longer identifies as an
agent: the fallback tree may revisit that PID and reread its argv/group. A
per-pass visited-PID cache would remove this transition-path duplication, not
the steady fixture's cost. Linux group checks already use scalar `getpgid` after
V13; claiming a repeated `/proc/PID/stat` allocation on this common path is stale.

An equivalent experiment could retain raw cmdline bytes and decoded identity,
still read at 250 ms, and rebuild strings/classification only when bytes change.
It preserves same-PID exec/argv freshness but leaves acquisition syscalls. The
V12 foreground span was 197.8 ms/min, a 0.330 CPU-percentage-point wall ceiling
before later changes; its actual removable CPU must be measured separately.

## CWD, titles, screen observations and persistence

Corgi refreshes CWD after each dirty terminal maintenance pass. In this scene
that is about 320 process `readlink`s/s, plus 17 pane refreshes on each recovery
save, approximately 8.5/s at the sustained 2 s save cadence. It tries the detected
agent, then foreground group, then pane process, stopping on success. The common
agent path therefore does not also query the foreground group. This buys
output-following CWD and workspace-directory updates on the next 50 ms maintenance
tick. Launching a new pane independently refreshes its source CWD on demand.
See [maintenance](../../src/server.ts:365), [CWD lookup](../../src/runtime.ts:365),
[workspace following](../../src/server.ts:155),
[fresh launch lookup](../../src/session.ts:72), and
[checkpoint refresh](../../src/persist/checkpoint.ts:169).

Herdr's PTY path publishes a CWD event only when the terminal reports a changed
CWD. Other paths read live process CWD on demand or for persistence; reported
CWD can satisfy ordinary queries. Its foreground-group leader also has a
different precedence from Corgi's detected-agent PID. See
[changed OSC CWD publication](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane.rs:2209),
[reported/process lookup](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane.rs:3806),
and [launch following](/home/t/dev/personal/herdr-cpu-benchmark/source/src/app/creation.rs:30).
No general freshness-preserving CWD cache follows from stable PID or screen
content: a process can chdir without changing either. V12's 84.8 ms/min CWD span
is only a 0.141-point wall ceiling, so this is not the main remaining gap.

Corgi materializes title text during each due detection pass, about 64/s here;
its title revision could safely retain an owned string until revision changes.
Herdr separately tracks changed title sources and synchronizes only those.
Corgi's live screen text already has a surface-revision cache. Active streams
change that revision between observations, so this scene still extracts about 64
texts/s; Herdr identified working agents scan around 53/s. Herdr's text cache does
not skip identified-agent reads indiscriminately: it skips some unchanged idle
screen scans while keeping confirmation and lifecycle work. See
[Corgi title](../../src/pane/terminal.ts:72),
[existing text cache](../../src/pane/terminal.ts:285),
[Herdr title sources](/home/t/dev/personal/herdr-cpu-benchmark/source/src/server/headless.rs:1420),
and [screen cache/skip policy](/home/t/dev/personal/herdr-cpu-benchmark/source/src/pane/agent_detection.rs:107).
Title caching is equivalent but small; changing screen cadence/confirmation is
a state-transition latency tradeoff.

Corgi marks output durable and saves a complete recovery checkpoint around every
two seconds under sustained output. Herdr schedules a five-second debounce from
session metadata dirtiness and runs writes in a background thread; its PTY-read
callback does not mark each ordinary output chunk session-dirty. Crash-recovery
content and freshness therefore differ. Moving Corgi writes off its main thread
may reduce stalls but is not automatically a reduction in total daemon CPU.
See [output durability](../../src/runtime.ts:456),
[save deadline](../../src/server.ts:430), and
[Herdr persistence scheduling](/home/t/dev/personal/herdr-cpu-benchmark/source/src/app/session.rs:14).

## Additional product work

No equivalent CPU/RSS/GPU sampler was found in the pinned Herdr source/crates
or its dependencies. Its `/proc` accesses located in this audit serve process
identity and foreground detection, not host utilization sampling. Corgi's V14
resource worker measured about 0.522 CPU points, including 0.421 system points;
that is additional product work, not evidence of inefficient execution of an
equivalent Herdr feature. Earlier speculation about a Herdr host-resource scan
causing host-population sensitivity was unsupported.

A separate supported-preference attribution should measure default Corgi against
decoration intensity 0 plus resource readings disabled. Intensity0 still keeps
informative working spinners and compaction feedback; it is not animation-free.
This experiment can bound these extra features' cost, but cannot establish
default-feature parity with Herdr. Keep that result separate from product
comparisons and from implementation changes.
