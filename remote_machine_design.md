# Remote machines in Corgi

This document describes the implementation on `design/remote-attempt-2`
(2026-11-05), and the design constraints for extending it. Sections
marked **Proposed** describe work that is not implemented. The command reference
is [Machines over SSH](docs/remote.md); [the earlier proposal](docs/remote-access.md)
is historical context. Where older documents disagree about protocol versions,
use [protocol.ts](src/protocol.ts) and the compatibility rules below.

## Goal and invariants

A remote machine should feel like another place to work in Corgi. Its agents,
shells and workspaces survive the viewer going away. A slow or unreachable
machine must not prevent local work, navigation, rendering, or connection
management. Native agent UIs remain a supported interface, even as we move toward
structured communication with agents and a local composer.

SSH is the usable baseline. Eventually, Corgi should opportunistically improve
that connection, with comparable authentication and confidentiality, without
making the first usable screen wait for an experimental transport. Discovery
and authentication costs should be amortized, and failed alternatives probed
again occasionally. Today, transport is SSH only; recovery races a fresh SSH
connection. There is no WebTransport negotiation yet.

The design rests on these invariants:

- The remote daemon owns processes, terminal state, files and agent execution.
  The local viewer owns its presentation and the physical terminal it draws on.
- Machine-local IDs are meaningful only with their machine and daemon incarnation.
  Cached rows are useful presentation, never authority to address a new daemon.
- A connection may die without the logical viewer session dying.
- Typing is held, never dropped, while a screen catches up. Held keys go to the
  pane they were typed into once the machine is online, never to a replaced
  daemon.
- Lost acknowledgments do not justify blindly repeating mutations. Replay is
  permitted only within the logical link's deduplication contract.
- A reconnect never installs software or restarts agents. Deployment is a
  separate, explicit setup operation.
- Prediction changes what the viewer draws, not what the agent received.

## Architecture and ownership

```text
Physical terminal
    │ keys, clipboard, capabilities                 frames, status
    ▼                                                   ▲
Host + one Controller + machine_viewer render/input loop
    │
    ├── Machine(local)  ── Endpoint ── local Unix socket ── daemon
    │
    └── Machine(remote) ── Endpoint / logical Link
                              │
                         RPC + Stream
                              │
                         Remote transport
                              │ local private socket adapter
                         OpenSSH channel
                              │ stdin/stdout
                         native bridge
                              │ remote private Unix socket
                         remote daemon ── PTYs / agents / files
```

| Abstraction | Responsibility | Boundary it must preserve |
| --- | --- | --- |
| [Host](src/host.ts) | Terminal capabilities, colors, clipboard, frame pacing and viewer preferences | Describes the terminal running the viewer, not the remote host's terminal environment |
| [Controller](src/controller.ts) | One coherent UI, actions, dialogs, selection and aggregate machine presentation | Remote work cannot block the render loop; late results cannot pull the user back to an abandoned selection |
| [Machine](src/machine.ts) | One daemon's mirror, navigation, controls, task ownership and presence | IDs, selections and pending work stay associated with their daemon |
| [Endpoint](src/machine_connection.ts) | Connection lifecycle, health, retries, generations, input gating and link resumption | A late callback from an abandoned attempt cannot change the replacement connection |
| [Tasks](src/tasks.ts) | Asynchronous daemon operations bound to their originating transport | Operation completion and UI focus changes are separate decisions |
| [Remote](src/daemon_transport.ts) | A local socket interface backed by SSH stdio, or legacy forwarding | Carries bytes; it does not own RPC policy, retries or rendering |
| [Connection](src/rpc.ts) | Framing, request/reply correlation, unsolicited events and deadlines | A reply belongs to its request, even when replies arrive out of order |
| [Stream](src/machine_stream.ts) | Surface subscriptions, pushed frames, heartbeat health and bounded writes | Replaceable screen state must not become an unbounded backlog |
| [Link](src/link.ts) | Logical viewer identity and deduplication state across connections | A repeated numbered operation gets its original result rather than executing again |

There is **one controller for the viewer**, not one controller per machine.
`Machine` holds the state that differs by daemon; `Host` holds what is shared
by the physical viewer. An endpoint can create a controller for isolated use,
but the normal machine viewer supplies the shared controller to its endpoints.

The transport currently exposes a local Unix socket to preserve the interface
used by RPC and auxiliary clients. This adapter is useful migration machinery,
not a requirement that a future transport must implement SSH or local forwarding.
The stable conceptual boundary is a cancellable, backpressured connection carrying
protocol messages to one authenticated daemon.

## How Corgi changes for remoting

### The viewer becomes asynchronous throughout

Moving a socket to another machine is insufficient. Waiting for a command,
input acknowledgment or snapshot before drawing would put network latency on
every interaction. The machine viewer instead pumps endpoint work and draws
independently. Input, completed requests and changed frames wake it; idle
endpoints do not require continuous rendering.

Actions launch tasks rather than awaiting daemon work in the render loop. Tasks
capture their transport. Results update the appropriate machine; before changing
what is visible, continuations check whether the user is still in the relevant
machine/workspace/tab. For example, a delayed new-pane response must not switch
the user back after they navigate elsewhere.

Some actions determine where subsequent typing belongs. Those tasks hold
following pane input for at most one second. This preserves ordering for actions
such as splitting or closing a pane without blocking rendering or the independent
connection controls. This is a bounded dependency between input and an action,
not a global UI lock. Shared-state edits also need validation after an asynchronous
refresh: an agent drop must be cancelled if the list changed during the drag.

### Machine ownership becomes explicit

Workspace and agent lists aggregate machines, while each machine remembers its
own navigation. Only the selected machine streams visible pane surfaces.
Background machines retain metadata and resource subscriptions without resizing
hidden panes or acknowledging their output as read. Resource hover must route
to the row's owner, even when that machine is not selected.

Remote CLI paths are resolved on the remote host. A local `CORGI_PANE` must not
accidentally select the same numeric ID remotely. Switching the viewer does not
retarget commands in an already running shell. Provider accounts and credentials
remain on their owning machine; the remote viewer cannot treat matching local
filesystem paths as the remote account store.

### Presentation survives disconnection

The viewer keeps the last screen in memory while disconnected. Separately,
[machine_cache.ts](src/machine_cache.ts) persists workspace cards, activity counts
and resource readings, so reopening still shows where work was happening. It does
not persist terminal contents. Cached rows are dimmed and qualified by profile
and daemon identity; a new daemon invalidates old ID-based selection.

Status indicators occupy stable space. Connection animations must not shift
workspace names, counts or click targets. A machine remains discoverable in the
machine dropdown even when every attempt to reach it fails.

## Connectivity and SSH sharing

Setup uses ordinary OpenSSH authentication and host-key confirmation. Background
attachments use batch mode and strict host-key checking: they neither prompt for
credentials nor silently trust a new or changed host. SSH aliases, jump hosts
and existing authentication configuration remain usable. Agent forwarding, X11
forwarding and `LocalCommand` are disabled.

Normal channels share a private, Corgi-owned SSH master, scoped by the local
Corgi state directory and SSH target, with ten minutes of idle persistence. This
amortizes TCP setup and authentication without borrowing an unrelated user-owned
master. Each local adapter client opens an SSH channel and a native bridge
process remotely. Sharing a master means sharing the underlying SSH connection;
it does not mean sharing one bridge process or one daemon client.

The bundled [corgi-remote-bridge](native/remote-bridge.c) connects stdio to the
remote daemon's Unix socket. Attachments do not boot Bun merely to copy bytes.
The helper uses nonblocking I/O and independent 64 KiB buffers in each direction.
A versioned preamble lets the client discard shell banners before parsing daemon
traffic. Protocol and reconnect policy stay in TypeScript.

Old profiles lacking a bridge path use dedicated SSH Unix-socket forwarding
(`-L local_socket:remote_socket`). This requires SSH stream-local forwarding
permission. Re-running setup discovers the native bridge. There is no public
Corgi listener or mandatory relay in the current design.

**Sharing does not eliminate head-of-line blocking.** Separate SSH channels still
share one TCP connection and congestion behavior. A lost TCP segment can delay
all channels on that connection; bounded application buffers cannot remove this.
Bulk image uploads, machine checks, manual retries and recovery probes therefore
use independent connections. Normal viewer and CLI traffic can still interfere
under saturation. The number of connections is workload-dependent, not a fixed
one-control/one-data pair.

## Health, recovery and user communication

Health means application progress, not merely a live SSH process. Stream
heartbeats and outstanding-write age detect silence even without typing.
Current policy values live in `connection_stats.ts`, `machine_connection.ts` and
`machine_stream.ts`. Successful application round trips maintain a smoothed mean
and deviation. The remote stall budget is `1s + 3 × mean + 4 × deviation`, clamped
to 4–30 seconds. Failures, replies spanning a detected stall and the initial
SSH/hello exchange do not train this
estimate; a slow but progressing connection stays online.

| Condition | Current behavior |
| --- | --- |
| No expected progress for the learned stall budget | Show stalled status and elapsed age; pause input and discard unsent input |
| No expected progress for twice the stall budget | Race a fresh, independently authenticated SSH connection alongside the old one |
| Initial SSH/hello exceeds 30 seconds | Cancel startup and reconnect |
| Laptop wake / suspected network change | Trigger a fresh-path probe, subject to race scheduling |
| RPC/stream wait reaches three times the stall budget, or socket breaks | Fail the connection and reconnect |
| Repeated connection failures | Retry immediately once, then back off through 1, 2, 4, 8 and at most 15 seconds |
| Explicit retry | Cancel ordinary startup and any probe; bypass the shared master and retry immediately |
| Explicit pause | Cancel attempts and stop automatic retries |
| Incompatible peer | Stop normal retries and explain that matching software is needed |

A recovery probe first validates `hello` and the same daemon incarnation. It can
replace the stalled path only while its attempt is still current. If the old
connection recovers first, the probe loses. A busy daemon that cannot answer
on either path is not made healthy by creating more sockets. Generation,
selection and interruption checks fence callbacks from cancelled attempts.

The UI distinguishes connecting, waiting for the daemon, stalled, offline with
a retry countdown, paused, incompatible and online. During an outage it shows
that input is paused and exposes retry, pause and detach. Ctrl+R, Ctrl+X and
Ctrl+C provide these operations in the stalled view; the machine dropdown exposes
management without stealing those keys from a healthy native TUI. Local work
and navigation remain available throughout.

Reconnect is not complete until a fresh subscribed screen has been displayed.
A successful handshake alone cannot authorize input against a cached pane. The
first pane render also waits for fresh screen data, avoiding default terminal
state briefly showing a cursor that the remote program has hidden.

Pausing or detaching affects the viewer connection, not remote agent lifetime.
An unresolved mutation is reported as potentially having run. A connection error
must not be presented as proof that an operation failed on the server.

## Protocol behavior and delivery guarantees

### Compatibility boundaries

Current management protocol is **1**, runtime protocol **4**, and viewer protocol
**4**. `hello` exposes compatibility, capabilities and daemon incarnation.
Streaming and links are capabilities (`viewer.stream`, `link.open`,
`link.resume`), not implications of a version-looking binary name. Remote
viewers require streaming; use matching builds as the supported deployment path.
The bridge's preamble version is a separate byte-transport boundary.

Checkpoint schemas, live handoff compatibility (`update_abi` / terminal ABI),
wire protocols, build identity and release version answer different questions.
A peer can speak a compatible wire protocol while still being unsuitable for a
live process handoff. Do not collapse these checks into one version comparison.

### Correlation is different from replay identity

`request_id` correlates one request with its reply on a physical connection.
It allows out-of-order completion and separates RPC replies from pushed events.
It does not prove that a mutation was executed only once after reconnecting.

For operations classified by `protocol.once`, an endpoint sends a logical `seq`
and a contiguous `answered` watermark over a `Link`. The daemon admits sequences
in order, retains results, and shares the pending result when a duplicate arrives
while an operation is still executing. A cached reply is returned using the new
connection's request ID. Acknowledging reply 7 cannot discard reply 6 if 6 has not
yet arrived at the client.

A link can retain viewer identity and pending controls for ten minutes after
detachment. Retention is bounded: currently 256 cached replies per link and 32
detached links. The client also bounds outstanding numbered requests. These are
limits, not a durable transaction log. Live handoff carries link state; a fresh
daemon incarnation is a different authority.

On reconnect to the same surviving link, already-numbered requests whose replies
were lost can be resent safely within that contract. If the link is gone, results
expired, or the daemon was replaced, the viewer cannot infer the result and must
not replay an uncertain mutation into a new session. This provides deduplicated
execution while the relevant link state survives, not universal exactly-once
execution across crashes and arbitrary external side effects.

Standalone CLI mutations are not automatically retried. Deferred worktree
checkout uses a separate connection and reports a lost result instead of
replaying it. Adding an operation requires an explicit decision about its replay
semantics, especially if it starts external work before replying.

### Screens, input and backpressure

Surface updates are replaceable state. `Stream` retains a coalesced frame, keeping
the latest surface for each pane, and uses a subscription sequence to reject
frames for obsolete interests. Session snapshots and resource updates must survive
coalescing; controls are acknowledged through their own sequence. Rendering a
screen is distinct from receiving it and from marking its output read.

Input is ordered data, not replaceable screen state. Writes can be in flight
without waiting one round trip per key, but are bounded to 1 MiB and 64 writes
at the stream layer. Logical replay is owned by the endpoint/link, not by the
stream. Overflow fails explicitly rather than accumulating unlimited memory.

Unsent input waits in its pane through a stall, a reconnect or a machine
switch, and goes once the machine is online. An interrupted paste finishes
after the outage. Sent, numbered input is recovered through the same link, so
held keys arrive once. A replaced daemon gets none of the old one's keys.

Clipboard and image operations capture their original machine/pane and connection
context. Remote image upload uses an independent SSH connection, validates the
format, and is limited to 32 MiB. Progress reports bytes received by the remote
helper. “Uploaded” means a remote file was saved, not that the agent consumed it.
The resulting remote path is delivered only while the operation still owns its
target. Cancellation or reconnect must not redirect a paste elsewhere.

## Deployment, versioning and upgrades

`corgi machine add` and `corgi machine check` own build reconciliation. Ordinary
background attachment does not. The policy is one canonical Corgi installation
on each host, also used by an ordinary shell invocation; there is no independently
aging remote-only daemon distribution.

Setup locates the existing executable, including managed release launchers and
symlink targets. If none exists, the default is `~/.local/bin/corgi`.
`--executable` selects a nonstandard installation; it is not required for normal
setup. Arbitrary wrapper scripts are not silently overwritten.

The newer comparable build wins. If local is newer, setup installs the matching
remote artifact. If remote is newer, setup upgrades the local installation first
and re-executes setup. Release versions are compared with commit consistency
checks. Development builds use binary/source hashes and Git ancestry, with
explicit handling of dirty builds; divergent or otherwise unordered builds stop
with an error instead of choosing by timestamp.

Signed release artifacts use the local installation's configured update trust
and the exact requested version. Development artifacts must match the required
source and target. For a different architecture, build the matching
`dist/corgi-<target>` plus metadata with `bun build.ts --target <target>`.
A newer same-platform development binary can also be fetched from the SSH peer
and verified against its reported hash. That is trust in the authenticated host,
not independent publisher attestation.

Installation stages and verifies the candidate, checks that the destination has
not changed, takes the installation lock, and preflights compatibility. Managed
installations preserve their launcher and release slots; standalone installations
replace the canonical executable with backup/rollback handling. A running daemon
uses live handoff to preserve shells. Incompatible handoffs are refused rather
than replaced by a destructive restart. Ambiguous upgrade outcomes preserve
recovery information instead of claiming success or blindly rolling back a daemon
that may already be running the new build.

The implementation is in [machine_setup.ts](src/machine_setup.ts),
[machine_build.ts](src/machine_build.ts) and [machine_install.ts](src/machine_install.ts).

## Native agent UIs and structured interaction

Predictive rendering is a local overlay over recognized Codex/Claude composers.
It previews a conservative set of ASCII edits and known wrapping behavior;
remote terminal state remains authoritative. Unsupported input, completion menus,
ambiguous layouts and uncertain wrap boundaries use remote echo. Unconfirmed
previews expire after 750 ms and are discarded on relevant connection, pane,
selection or geometry changes. They never modify copied terminal contents or
cause replay. The preference is shared across this viewer's machines.

**Proposed:** structured agent interaction should let Corgi keep composition and
navigation local while sending prompts, approvals and steering through explicit
provider operations. This needs provider capabilities and delivery receipts,
not more inference from terminal pixels. Native TUI attachment remains a parallel
presentation of the same agent, preserving users' preferred controls and workflows.
Prediction is a latency aid for that interface, not a substitute for a responsive
transport or an agent protocol.

## Meaningful open problems

### 1. Secure adaptive transport and promotion

**Proposed:** use authenticated SSH to discover alternatives and bind a short-lived,
scoped grant to a particular daemon and viewer. Attempt a direct path without
holding up usable SSH. Cache successful reachability, back off failures, and
reprobe on a bounded schedule or network change. WebTransport is a candidate,
not an implementation commitment.

The difficult part is safely promoting a path while requests are in flight:
who owns input, how old-path writes are fenced, and what happens when the promotion
acknowledgment is lost. The current fresh-SSH race is a useful foundation but does
not define a general multipath protocol. Before shipping, demonstrate identity
binding, revocation/expiry, old-path fencing, UDP-blocked fallback and lost-message
promotion tests. Decide whether direct transport grants can bypass authentication
requirements that the user's SSH setup would otherwise enforce.

### 2. Shared connection congestion and fairness

Independent uploads and probes isolate important failure modes, but ordinary
viewer output, RPC and other shared channels still compete. Measure confirmed
input latency under noisy panes and concurrent commands before choosing between
more independent SSH connections, explicit traffic prioritization, or a transport
with independent streams. More channels on one TCP connection do not resolve
loss-induced head-of-line blocking. Success means bounded input/control latency
and bounded memory under saturation, with prediction disabled.

### 3. Delivery beyond retained link state

A ten-minute in-memory link cannot resolve every crash or long outage. External
side effects can finish before their result is durably known. Decide which actions
need a persistent operation identity and queryable status, versus an honest
“outcome unknown; inspect before retrying.” This matters most for prompt submission,
approvals, pushes and worktree operations. Do not promise general exactly-once
behavior by extending a timeout or adding another request ID.

### 4. Upgrade authority, compatibility policy and multiple viewers

Automatically upgrading local Corgi from a newer development peer expands the
trust placed in that peer. The product needs an explicit policy for trusted dev
hosts versus release-only installations. A hash supplied by the same peer proves
transfer consistency, not publisher trust.

Also define what happens when several viewers want different builds of the same
canonical daemon. “Newer wins” cannot by itself prevent upgrade churn, unavailable
cross-platform artifacts, or disruption of older clients. Establish a supported
compatibility window and diagnostics for why setup cannot reconcile. Test
concurrent upgrades, interrupted transfers, post-handoff disconnects and rollback
against both managed and standalone installations.

### 5. Explainability without misleading health claims

Current status distinguishes SSH startup from waiting for the daemon, but a silent
path cannot always reveal whether the network, daemon, a particular operation or
a shared channel is responsible. Define a small diagnostic record containing
attempt/generation, path type, last progress, outstanding work and retry reason,
without recording prompts, terminal contents or credentials. Users should be able
to tell why input is paused, what Retry changes, and whether an action is uncertain.
A stalled operation and a dead machine should not be conflated where evidence
allows them to be distinguished.

### 6. Structured agents and native UI coexistence

Define ownership when a local composer and native TUI can both write to one agent.
Prompts, edits, steering, cancellation and approval responses need stable targets
and receipts across reconnects. Provider-specific capabilities must describe what
is actually supported. Test simultaneous viewers and a provider restart; avoid
sending a local draft to a replacement conversation simply because its pane ID
was reused. Native UIs must remain usable without structured support.

### 7. Browser access has a separate trust and deployment problem

**Proposed:** a browser cannot reuse the native SSH process and local credential
agent directly. Pairing, origin policy, certificate trust, credential expiry and
reachable transport must be designed together. A static hosted frontend still
participates in the trust boundary because its JavaScript handles session data.
Validate the deployment and supported browser/network combinations before
promising browser access; retain the native SSH path independently.

## Validation for continued development

The regression suite must test behavior during failure, not merely successful
attachment. [tests/remote.test.ts](tests/remote.test.ts) uses real OpenSSH, disposable
daemons, native terminal viewers and a TCP fault proxy. It exercises one-way
stalls, blackholes, stranded masters and recovery handshakes, cuts, repeated
reconnection, daemon replacement, input delivery, clipboard ownership and local
responsiveness. It also compares authoritative echo with plain SSH and exercises
prediction behind delayed or withheld responses.

```sh
bun build.ts --test
bun integration.ts remote --jobs 1
bun integration.ts remote --jobs 1 -- -t 'shared_master_and_failed_recovery|spotty_connection|pause_and_retry'
```

Keep four measurements separate: local UI response, predicted display latency,
authoritative remote echo, and recovery time. Report latency distributions and
resource bounds under competing traffic, not just one successful keystroke.
The current real-SSH tests are necessary but do not prove browser security,
QUIC behavior or general performance SLOs. Add loss/reordering and path-promotion
fault injection if an alternate transport is introduced.

Each new asynchronous UI operation should be tested with a late reply after a
machine switch and a failed connection. Each new mutating protocol operation
needs a lost-reply test and an explicit replay decision. Each deployment change
needs a running-shell handoff test and an interrupted-upgrade test. Full unit,
typecheck and applicable integration checks remain the repository gates; run
latency-sensitive integration tests without competing test loads, and rerun a
failure serially before diagnosing it as a product regression.
