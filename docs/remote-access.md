# Remote access, attempt 2

> Historical design baseline, written before the SSH port. The implementation
> and current limitations are documented in [Machines over SSH](remote.md).
> The discoveries below describe the pre-port checkout.

Design proposal, 2026-10-24. Based on local `main` at `4fd83e119281` and
the earlier “Design Corgi Remote Access” discussion
(`01a12df0-8a5d-7a73-b796-27925539523d`). No implementation is included.

The remote session should outlive the connection carrying it. Start with a
working, authenticated path, improve that path without interrupting the user,
and keep the UI responsive when every remote path is unavailable.

## Assumptions

- Native Corgi connects first; a browser follows. This matches the earlier
  discussion. The transport and session contracts must accommodate both.
- Users already have SSH access, usually over a corporate network or VPN.
  Direct reachability is opportunistic. No Corgi cloud relay carries their data.
- A machine can have several Corgi runtimes. A remote names the SSH destination,
  user and selected runtime, not just a hostname. Each runtime keeps owning its
  processes, workspaces, conversations and terminal emulation.
- Native provider UIs remain a supported way to work. A future Corgi composer
  is an additional presentation, not a prerequisite for reliable remoting.

The previous attempt also established product requirements: show all workspaces
by default; put the machine filter beside “Workspaces”; preserve workspace rows
through outages and reopening; never delay local startup; and never make status
animations push content around. Resource hover must work for any workspace.

## Surprising discoveries

The current separation is useful: the daemon owns terminal state and the viewer
renders surfaces. It is not yet a network session interface.

| Current code | Consequence for remoting |
| --- | --- |
| [viewer.ts](../src/viewer.ts), `sync` and `run` | The main loop awaits pane input flushes, then `viewer.sync`, before rendering. A distant daemon can add serial round trips and hold up local interaction. Input and incoming frames already wake the loop; simply shortening a timer would miss the current problem. |
| [rpc.ts](../src/rpc.ts), `Connection` | Replies match pending calls by FIFO position. There are no request IDs, request cancellation or reconnect receipts at this seam. |
| [viewer_protocol.ts](../src/viewer_protocol.ts), `sync` | Unchanged surfaces are omitted, but changed surfaces are captured as whole views. `viewer.watch` wakes a client to request data; it does not push the data itself. |
| [server.ts](../src/server.ts), `enqueue`; [peer.ts](../src/peer.ts) | Daemon jobs and per-client requests are serialized. Adding network streams alone does not remove application-level blocking. Long work needs asynchronous jobs with short state-application steps. |
| [controller.ts](../src/controller.ts), `launcherDir` and `listBranches` | Some operations open another connection from a local socket pathname. These must become endpoint operations. |
| [viewer.ts](../src/viewer.ts), clipboard setup; [viewer_protocol.ts](../src/viewer_protocol.ts), `paste` | Image paste assumes the viewer and daemon share a filesystem. Remote paste requires upload and a remote-owned blob handle. |
| [mirror.ts](../src/mirror.ts); [controller.ts](../src/controller.ts) | A controller still has one runtime and connection. Aggregation must be a data change, not one controller per host. |
| [headless.ts](../src/headless.ts); [providers/adapter.ts](../src/providers/adapter.ts) | Structured prompts, answers and interrupts already exist for daemon-hosted agents. They do not imply control of arbitrary native provider processes. |

Installed Bun is 1.4.4; a read-only runtime check returned
`typeof globalThis.WebTransport === "undefined"`. Bun documents experimental
[HTTP/3 serving](https://bun.sh/docs/runtime/http/server#http3-quic), while its
[WebTransport support issue](https://github.com/oven-sh/bun/issues/13656) remains
open. HTTP/3 serving is not proof of a usable WebTransport client/server pair.
The direct transport needs a feasibility spike before choosing its dependency.

The earlier transcript reported scheduling and prediction improvements in the
old implementation. Those measurements are historical, not measurements of
this checkout. Reuse its scenarios, not its performance claims or architecture.

## Decisions

### One UI, independent endpoints

Keep one controller, sidebar, focus model, hover model and menu system per
viewer. An endpoint owns connection state and a data store, never another UI.
Build the combined workspace list from those stores. Every row and action
carries its owner, including resource details, worktrees, launchers and agents.

Qualify remote references by endpoint, daemon incarnation and local ID. Pane
input also carries terminal identity and attachment generation. Keep provider
session IDs and existing daemon-local actor IDs as defined in
[CONTEXT.md](../CONTEXT.md); do not invent globally unique provider sessions.
Capture a target when an action starts rather than consulting current focus
when a delayed response returns.

An `Endpoint` module exposes current data/status, interest updates, input
submission, command receipts, retry and disconnect. Its implementation owns
network I/O, deadlines, authentication, candidate paths, resumption and bounded
queues. The controller renders immediately from current data; it never awaits
a remote reply before processing another input or drawing a local menu.
Keep protocol vocabularies in [protocol.ts](../src/protocol.ts), not in each
transport adapter.

Use one long-lived logical connection per endpoint per viewer, shared by its
panes and workspaces. Keep it through workspace switches. Reuse authenticated
SSH connections where configuration allows it. Start without a new local
broker process; sharing all network connections between viewers can follow if
measurements justify the additional lifetime and ownership rules.

Background endpoints send metadata and requested details. Only visible panes
request terminal surfaces or sizes. Expiring viewer interests release stale
watch/resize claims without stopping the remote processes.
Each workspace and its splits remain on one owning runtime initially; the
combined list does not imply cross-machine pane layouts.

### SSH establishes trust; direct transports earn promotion

Use the best authenticated, compatible, policy-permitted path that is actually
working. “Best” includes latency under load, stability and setup cost, not just
the protocol's name.

| Path | Role |
| --- | --- |
| Local Unix socket | Existing local runtime access. No remote negotiation. |
| OpenSSH exec/stdio | Initial baseline: a non-PTY Corgi bridge attaches to the chosen runtime. It keeps working when direct connectivity fails. |
| Direct WebTransport over HTTP/3 | Preferred upgrade candidate for independent streams and network changes, subject to implementation and network support. |
| Direct TLS WebSocket | Useful TCP alternative when UDP fails; promote only when measurements or reachability warrant it. It does not remove TCP loss blocking. |
| SSHD forwarding to a private runtime socket or authenticated loopback gateway | Compatibility fallback where bridge execution is unavailable or unsuitable. No exposed unauthenticated TCP daemon. |

OpenSSH supports forwarding TCP and Unix sockets, and connection reuse through
`ControlMaster`/`ControlPersist`. Respect SSH aliases, host verification,
ProxyJump and authentication configuration. Keep Corgi-owned control sockets
private and separate from user-owned connection lifetimes. Do not forward the
SSH agent or allocate a remote PTY for the protocol bridge.
([ssh](https://man.openbsd.org/ssh.1),
[ssh_config](https://man.openbsd.org/ssh_config.5))

Ordinary SSH forwarding does not carry UDP WebTransport. A forwarded fallback
uses the reliable stream protocol. A forwarded legacy socket also cannot add
session resumption or safe promotion to an old daemon; those require remote
protocol support. If that support is missing, explain the version mismatch and
offer an explicit update path rather than silently replacing a running daemon.

QUIC can isolate loss between streams and can support address migration.
It still needs path validation and shares connection congestion constraints;
it neither eliminates RTT nor guarantees recovery after every network change.
([RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html))

### Equivalent trust requirements, with explicit delegation

Encryption alone is insufficient. The direct path must authenticate the same
remote user/runtime, authenticate the client, constrain authority, and reject
identity changes. The design is not a claim that a new implementation is
already as thoroughly assessed as OpenSSH.

Bootstrap through verified SSH. The remote gateway supplies its TLS certificate
pin, runtime identity, supported protocols, permitted addresses and a random,
short-lived authorization grant scoped to this user, runtime and logical
connection. Validate the pin before sending any credential or session data.
Authenticate on the first encrypted control message before exposing metadata.
The gateway must not be a public raw proxy to every local management operation.

Use established TLS and cryptographic libraries. A concrete initial credential
scheme is a 256-bit random, single-use bootstrap token, then short-lived,
single-use path tickets issued over an authenticated path. Tickets name the
logical connection and intended path attempt; server-side state consumes them
atomically. A lost ticket can always be replaced through SSH. Retain credentials
only in protected memory; omit them from URLs, argv, logs and workspace caches.
Bound unauthenticated connection time, message size and connection counts.

The overall authorization lease is bounded and renewed through SSH, not extended
indefinitely by possession of a direct-path ticket. Its duration and refresh
requirements must follow deployment authentication policy. A TLS resumption
ticket never replaces application authorization. Explicit disconnect revokes
the logical connection and its outstanding tickets when reachable; otherwise
they expire. Do not promise immediate remote revocation during a partition.

Direct access is an explicitly supported server policy, with an “SSH only”
setting. An SSH bastion, forced command, MFA rule or destination restriction
must not accidentally become a route around that policy. Unknown/changed host
keys, invalid pins and revoked credentials are security states, not ordinary
network failures. Stop attempts on the suspect identity and retain only a
separately verified healthy path; never auto-accept a replacement identity.

Use handshake resumption, but disable application mutations in TLS/QUIC 0-RTT;
early data can be replayed. ([RFC 9001](https://www.rfc-editor.org/rfc/rfc9001.html#section-9.2))

### Negotiate without delaying usable work

On the first connection, show local data and cached remote workspace rows
immediately. Establish SSH, negotiate the session contract and attach. The
baseline becomes usable as soon as its current state arrives. Probe advertised
direct candidates alongside that working connection.

On subsequent connections, race a still-authorized cached direct candidate with
the baseline, with a small stagger if needed. Do not serially exhaust QUIC,
then WebSocket, then SSH timeouts. Never race multiple interactive SSH/MFA
prompts. Use one explicit authentication flow, cancellable from the UI.

Cache successful paths and network failures by endpoint identity, runtime,
capability version and network context. Cached reachability is a hint, not
authentication. A network change invalidates negative reachability results;
an identity or authorization change invalidates credentials.

Initial tuning proposal, to validate rather than treat as protocol guarantees:

- Give a background candidate about 1 second, extended for measured high RTT.
- Retry failed upgrade probes after 30 seconds, 2 minutes, then 5 minutes,
  with jitter. Probe sooner after a network change or explicit retry.
- Require several healthy samples and a meaningful advantage before promotion;
  stay on a healthy path for at least 30 seconds to avoid oscillation.
- Retry a failed active connection promptly, then back off from 250 ms to
  10 seconds with jitter. Retry now bypasses backoff; Disconnect stops retries.

Measure application heartbeat/ack progress, not just an open socket. A starting
policy is a heartbeat every second while watched, “not responding” after
`max(2 seconds, 4 × smoothed RTT)`, followed by recovery attempts. Background
endpoints can use slower heartbeats. In the stalled state, stop accepting new
terminal input and remove predictions. Local interaction remains available.

### Promotion and recovery are session operations

Separate persistent endpoint identity, daemon incarnation, logical viewer
connection, transport epoch, request ID and pane attachment generation. Each
protects against a different stale reference. Use `bigint` for long-lived wire
sequences. A cold daemon start always changes incarnation. Live handoff may
retain it only if session fences and receipt ledgers transfer intact.

For a healthy upgrade:

1. Authenticate the candidate as a standby path for the existing logical
   connection. A probe must not create panes, resize terminals, change theme,
   acknowledge notifications or become another active viewer.
2. Stop dispatching new mutations briefly and fence the old mutation lane at
   sequence N. The daemon resolves acceptance through N; jobs already accepted
   may continue under their request IDs.
3. Commit a new transport epoch at the daemon. Only that epoch may submit new
   mutations for this logical connection. Install the current snapshot and
   surface baselines before releasing fresh input on the new path.
4. Retire the old data path after confirmation. If the promotion reply is lost,
   query the authoritative epoch; do not guess or write on both paths.

During abrupt failure, recover receipt state and fence the old path before
reenabling input. Retain request IDs and input sequence high-water marks for
the resumption window. Retransmitting a receipt query is safe; blindly replaying
Enter, paste, an approval, a prompt or a shell command is not. An expired ledger
or new daemon incarnation makes unresolved effects unknown, not retryable.

Expose command outcomes as not sent, accepted, completed/failed, or unknown.
For terminal input, distinguish accepted into daemon/PTY processing from an
application's visible echo. A transport write or QUIC acknowledgement proves
neither that the program processed the input nor that a frame contains its
result. Do not claim exactly-once execution across daemon crashes.

While offline, retain and dim the last screen and preserve workspace metadata.
Do not secretly queue terminal keystrokes to execute after reconnect. A local
composer can retain an unsent draft with an explicit Send action. Surface and
attachment freshness are prerequisites for input; connectivity alone is not.

### Separate input, state and bulk traffic

Send input immediately on an ordered reliable lane. Do not await an input RPC
reply before sending subsequent keys or receiving the resulting surface.
Preserve order for dependent mutations and capture their targets. Separate
unrelated slow commands with request IDs and asynchronous receipts.

Push state when it changes. Keep a current snapshot and at most the newest
unsent surface per pane. Add surface deltas only against acknowledged baselines;
a missing baseline requests a full view. Keep metadata/control receipts reliable
and independent from replaceable screen updates. Apply limits before encoding
and before buffering in the transport, not only after a large write is queued.

Use distinct WebTransport streams for control/input, surfaces and bulk blobs,
with explicit scheduling and flow-control budgets. The SSH/WebSocket adapters
carry the same logical messages in bounded chunks; they retain TCP loss
blocking. Chunk and throttle bulk traffic so it cannot fill the interactive
queue. Start with reliable surface streams; datagrams can follow only if they
produce a measured benefit and retain baseline recovery.

Image paste uploads bytes to the owning runtime, receives a verified blob
handle, then submits the paste once. Its progress means remote bytes accepted,
not merely bytes written locally. Handle interrupted uploads, expiry and
cleanup separately from uncertain paste execution. Local files, resource links,
port forwarding, sign-in and launch-preview streams all need explicit endpoint
ownership; remote filesystem paths must never be interpreted locally.

### Prediction and direct agent control coexist

First make confirmed remote echo competitive with SSH. Prediction must not hide
an avoidable extra round trip or delayed rendering.

Native UI support includes the current terminal's keyboard modes, mouse,
alternate screen, bracketed paste, selection and supported Kitty graphics.
Keep that path available regardless of structured-control capabilities. Mode
and resize changes participate in input freshness, so keys are never encoded
using a stale terminal mode after reconnect.

For native agent UIs, prediction is a reversible overlay over authoritative
surfaces. Enable it only for recognized, supported editor states. Keep an off
switch. Track the prediction's draft generation, pane attachment, surface
identity, dimensions and input sequence. Confirm by observed editor state;
daemon input acceptance is not a reliable indication that an arbitrary TUI has
finished redrawing.

Clear/interrupt, resize, focus/attachment change, completion menus, password
input, unfamiliar editing modes and another writer invalidate the applicable
prediction. After Ctrl+C/Ctrl+U, do not rebase newly typed letters onto an old
draft while a clearing redraw is in flight. Unsupported states use normal
remote echo. Never synthesize submission, approvals or destructive commands.

Cover wrapping, navigation, Unicode/grapheme widths and paste deliberately;
provider-specific editor knowledge belongs in provider adapters. Measure the
fraction of edits predicted correctly and recovery flicker, not only the speed
of uninterrupted ASCII typing.

For the eventual local composer, extend the existing provider interface with
explicit per-conversation capabilities for send, steer, queue, interrupt,
approval and attach. Unsupported is a real result. Keep credentials and provider
control on the owning remote machine; the viewer talks to that daemon.
Native UI and structured control must select the same verified conversation
where the provider supports it. Do not promise seamless switching for a provider
that cannot attach to the running conversation, or disguise terminal typing as
a reliable structured command. Approval targets include the original request,
conversation and generation.

### Communicate state without moving the UI

Keep the machine filter beside “Workspaces”, defaulting to All. Show it once
remotes are configured, and retain it through outages. Local-only Corgi keeps
its current layout. Cache only enough private metadata to reconstruct ghost
rows on reopening; cached rows never authorize an action or imply current state.

Use a reserved status cell and a gentle glimmer across the affected workspace
name during connecting/reconnecting. Do not reuse the agent-thinking spinner.
Hover/click reveals the machine, path, last response age, latency, failure
reason, and Retry now / Disconnect / SSH only controls. Keyboard access uses
the same actions. A failed upgrade should not dim a healthy SSH session.

| Example status | Meaning |
| --- | --- |
| `nocap · SSH · 42 ms` | Working baseline. SSH is not presented as an error. |
| `nocap · Direct · 28 ms` | Direct authenticated path; details name WebTransport or TLS WebSocket. |
| `nocap · SSH · direct path unavailable` | Still usable. Do not claim “UDP blocked” from a timeout alone. |
| `nocap · reconnecting · last response 4s ago` | Cached state; terminal input disabled; local navigation available. |
| `nocap · sign-in needed` | Authentication needs action, with no endless hidden retry loop. |
| `nocap · identity changed` | Trust requires resolution; no automatic acceptance. |

### Browser follow-up

A stock browser can use WebTransport with a securely provisioned certificate
hash, including for a private endpoint. The pin authenticates the server, not
the client; client authorization is still required. Hash-pinned certificates
have a maximum two-week validity and require rotation. WebTransport does not
carry ordinary HTTP cookies. These are useful primitives, not complete pairing.
([W3C WebTransport](https://www.w3.org/TR/webtransport/#security-considerations))

Pair through an already trusted native/SSH session or deliberate out-of-band
verification. Browser pairing may need a separately approved durable device
credential; native session tickets should not quietly acquire that authority.
The browser cannot invoke the user's SSH client for fallback. If direct UDP
fails, it needs browser-trusted WSS/TLS or a local helper. A private certificate
pin supplied to WebTransport does not grant JavaScript arbitrary WebSocket
certificate exceptions. Validate actual browser, VPN and local-network access
policy combinations before promising no-setup browser access.

A hosted static frontend can leave application traffic directly between the
browser and remote machine. Its delivered JavaScript still joins the trust
model because it handles session data and credentials. No relay does not mean
no trust in the frontend distributor.

## Algorithm sketch and implementation order

1. **Endpoint ownership and responsive viewer.** Introduce qualified targets,
   data aggregation and an asynchronous endpoint interface. Use the local
   adapter and a delayed/failing fake endpoint to prove one UI handles every
   workspace without waiting on the remote.
2. **Reliable SSH session.** Add the bridge, versioned session messages,
   pushed state, receipts, bounded queues, reconnect, ghosts and explicit
   authentication/error states. Verify on Linux and macOS before any deployment.
3. **Direct transport spike, then promotion.** Prove a maintained WebTransport
   implementation works as client and server with the packaged Bun application,
   supported architectures, cancellation and constrained network conditions.
   Prefer a narrow native adapter/helper if Bun requires it; policy remains in
   TypeScript. Add authenticated tickets, path fencing, probes and TCP fallback
   against the same session tests. Do not call SSH-only completion the finished
   adaptive transport feature.
4. **Native typing prediction.** Add the overlay and provider editor adapters
   after confirmed echo and recovery pass. Replay the previous attempt's clear,
   wrap, completion, image-paste and hover regressions.
5. **Structured interaction and browser.** Extend provider capabilities and
   build the local composer; validate browser pairing and fallback separately.

Add a versioned remote session envelope with request IDs and events; do not
silently reinterpret FIFO replies or multiplex unsolicited events through
`Connection.pending`. Preserve management protocol 1 for discovery. Current
runtime/viewer protocols are both 3: any required changes to those contracts
need their own version bumps. New defaulted local preferences need schema
snapshots; persisted session fencing/receipt state needs explicit handoff
migration and continuity tests. Recheck the exact compatibility impact when
implementing, rather than freezing speculative version numbers now.

## Validation conditions

The release gate is measured behavior, not a successful connection demo.

- **Responsiveness:** with a remote completely blackholed, local startup,
  menus, scrolling, hover and disconnect remain responsive. Provisional target:
  local interaction within one frame; measured p95 below 50 ms on test hardware.
- **Confirmed echo:** compare Corgi remote, SSH plus remote Corgi, and Herdr's
  remote mode with prediction off, identical terminal/program and network
  shaping. Include 0/40/120/240 ms RTT, jitter, loss and constrained bandwidth.
  Initial target: no extra serial RTT and p95 within 10 ms of the comparable
  baseline in stable conditions. Record CPU and bytes as well as latency.
- **Negotiation:** first usable SSH state never waits for a direct-path timeout;
  cached direct success can win on reconnect. Test UDP blackholes, TCP-only
  access, ProxyJump, forward-only access, revoked grants and version mismatch.
- **Recovery:** lose each promotion acknowledgement; suspend/resume the laptop;
  switch networks; stall one direction; restart and live-reload the daemon;
  delay old frames; reuse pane IDs; lose a request after acceptance. No duplicate
  prompt, Enter, paste or approval; unresolved results remain visibly unknown.
- **Bounded work:** flood several panes while typing and uploading an image.
  Slow viewers cannot accumulate unbounded frames, starve input or stall other
  endpoints. An abandoned viewer stops imposing sizes and watch state.
- **UI integrity:** resource hover and actions work on inactive machines;
  workspace ordering and status widths survive outages/reopening; ghost rows
  never dispatch commands until refreshed. The local-only UI remains unchanged.
- **Prediction:** measure first-key latency, correctness/coverage and flicker
  through clears, wraps, Unicode, completion menus, paste, resize and another
  writer. Password/no-echo and uncertain editors never receive speculative echo.
- **Native UI:** exercise keyboard-mode transitions, alternate screens, mouse,
  graphics and bracketed paste on every transport, including reconnect mid-TUI.
- **Security:** test forged pins, expired/reused tickets, changed identities,
  unauthorized runtime/operation access, old epochs and replay attempts.
  Review the direct listener and credential lifecycle before claiming security
  parity; test supported browser origins when adding browser access.

Use deterministic session tests plus real OpenSSH integration tests, with a
controllable fault proxy and Linux network shaping where UDP behavior matters.
Run applicable repository checks for the eventual code changes. This design
inspection did not run builds, test suites, live SSH sessions or benchmarks.

## Considered but rejected

- **Tunneling today's synchronous viewer unchanged:** preserves serial waits,
  local path assumptions and weak delivery semantics.
- **One controller per machine:** repeats the old hover/state ownership failure
  and makes a combined workspace list difficult to keep consistent.
- **WebTransport everywhere, immediately:** reachability and implementation
  support must be demonstrated; SSH remains a supported working path.
- **Upgrade by closing SSH and opening a new viewer:** creates gaps, duplicate
  interests and uncertain command delivery. Promote within a logical session.
- **Datagrams for terminal input:** ordering and delivery are mandatory; any
  loss-tolerant optimization belongs to replaceable state with recovery.
- **A permanent token issued once by SSH:** creates independent standing
  authority and can bypass the intended authentication/expiry policy.
- **Prediction as the main performance fix:** conceals latency and fails on
  unfamiliar editors. Confirmed echo must work well independently.
- **Mandatory hosted relay or universal NAT traversal in the first version:**
  conflicts with the earlier direct-data requirement and is unnecessary for
  the reachable-network scope. Keep using SSH when direct access is unavailable.
