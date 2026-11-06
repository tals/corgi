# What the implementation suggests

These are source-based explanations to investigate, not causal conclusions
from the timing measurements. The [measurements](measurements.md) describe
observed behavior; the [playbook](README.md) defines the experiment.

**Startup failure.** The retained terminal recording shows `NoWorkspace` when
the harness selects a cached remote row before reconnection completes.
Corgi's [workspace switch](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/controller.ts#L872)
throws this error when the selected ID is absent from the controller's live
workspace set. A cached-navigation/live-state race is a plausible explanation;
the benchmark does not establish the complete call chain. Keep this as a
reproduction and fix the navigation failure before interpreting successful
attach medians as sufficient reliability.

**Different recovery behavior is expected.** Corgi
[detects a stalled stream and races a fresh connection](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/machine_connection.ts#L264),
with a four-second minimum race interval and adaptive budgets. Its viewer
[detects a long event-loop gap](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/machine_viewer.ts#L365)
and marks endpoints as suspect after waking. Herdr's
[health check](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/client/endpoint/health.rs#L1)
has a five-second idle heartbeat interval and a ten-second heartbeat timeout;
its [supervisor](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/client/endpoint/supervisor.rs#L10)
backs off retries. TCP retransmission timing also matters. A brief interruption,
a silent long outage and a reset therefore need separate measurements.

**Bandwidth efficiency has at least two plausible contributors.** Herdr
[enables SSH compression](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/remote/attach.rs#L1231)
by default. Corgi's [SSH arguments](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/ssh.ts#L23)
do not request it. The main comparison keeps each product's defaults;
`--ssh-compression yes` is a separate Corgi configuration diagnostic. It does
not modify either binary or Herdr's configuration.

Corgi [captures changed pane surfaces](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/viewer_protocol.ts#L234)
and sends JSON frames, delaying capture while its own output buffer is occupied.
Its [peer writer](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/peer.ts#L110)
caps that buffer at 4 MiB, but bytes already accepted into OS/SSH buffers are
outside that coalescing condition. Herdr's
[retained surface path](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/headless/retained_surface.rs#L518)
prepares incremental pane patches; its
[writer queue](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/client_transport.rs#L273)
holds one pending render message and separates control traffic. This does not
mean every Herdr queue is bounded, or that either product can retract bytes
already written to SSH.

The separate compression diagnostic improved Corgi's sparse 256 kbit/s p95
screen age from about 30 seconds to 20 seconds, with two of five inputs visibly
acknowledged. It did not close the gap. This is one trial per diagnostic
profile; it establishes a configuration effect in this fixture, without
isolating the remaining cost to one component.
[Diagnostic results](measurements.md#bandwidth-and-screen-freshness).

Smaller incremental updates and control over queued render history are
candidates for further testing. A useful regression target is fresh output and
acknowledged input during a sustained cap, plus prompt catch-up after its
removal. Measuring only throughput after the cap would miss stale history
accumulating during it.

**Input receipts are a separate correctness signal.** Corgi's viewer
[gates input on readiness](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/machine_viewer.ts#L323)
and displays “Input paused” while stalled. The experiment checks both an early
outage input and a later one, since a command submitted before detection may
already be in flight. Corgi's
[detached-link retention](https://github.com/tals/corgi/blob/eeef7b27d46316dec1fc216541337c5c1785f67e/src/link.ts#L8)
lasts ten minutes; the eleven-minute freeze crosses that boundary after
destroying old connections at the start. One successful recovery and an
unduplicated token do not establish exactly-once execution for all operations.
