# Machines over SSH

Phase one connects Corgi's CLI and terminal viewer directly to other machines.
Each machine keeps its own daemon, agents, files and Unix socket. There is no
Corgi network listener, account service or hosted relay.

Use an existing SSH alias. Setup reconciles the installed builds:

```sh
corgi machine add workbox
corgi machine add mini tal@mini --executable /Users/tal/.local/bin/corgi
corgi machine list
corgi machine check workbox

corgi --machine workbox list
corgi --machine workbox tab new --workspace 1 --cwd /work/project
corgi --machine workbox pane send 3 'run the tests' --enter
corgi list --all-machines
```

`machine add` checks the host through OpenSSH, starts Corgi if it is not running,
and verifies protocol compatibility before saving the profile. It upgrades the
older installation to the newer build, preserving the canonical Corgi executable
and using live daemon handoff to keep shells running. When Corgi is missing,
setup installs it at `~/.local/bin/corgi`. `--executable` selects a different
existing installation. Incompatible handoffs and divergent development builds
stop with an explicit error instead of restarting sessions. See HACKING.md for
cross-platform development artifacts and release verification.

With saved profiles, `corgi` starts locally and connects to the other machines
independently in the background. The sidebar shows **all workspaces**, with a
shaded machine header above each group and reception bars for remote link
responsiveness and reliability. Hover over a header for one second to see that
machine's response time, traffic and recent history. Headers repeat when workspaces
from different machines are mixed. Click a machine header to collapse or expand
its workspaces without switching the active pane. Collapsing preserves their
saved order, including workspaces interleaved with other machines.
Click any workspace or use the ordinary
workspace keyboard navigation to open it. Connecting or disconnected workspaces
stay visible but dimmed; local work remains usable during a remote outage.
With **agents: all**, the agent list shows every online machine's agents, each
workspace's header naming its machine. Clicking one, or moving to it with the
agent keys, opens it on its machine; folding a group folds it on that machine.

With a saved remote machine, **all ▾** appears beside **workspaces**, even before
its first successful connection.
Click it, press **Ctrl+]**, or use **prefix + Shift+M** for a dropdown of machines
and connection status. Arrows and Enter filter the list without switching the
active workspace; click a workspace to open it. Escape closes the dropdown.
Ctrl+F folds or unfolds the highlighted machine. Workspace keyboard navigation
skips paused machines and machines needing attention, but includes machines
that are connecting or automatically retrying. Opening a workspace unfolds its
machine.
Ctrl+R cancels the highlighted machine's current request or connection attempt
and retries immediately. Ctrl+X pauses it and stops automatic retries. A machine
stays in the dropdown through outages so these controls remain available.
Local-only Corgi has the same header as before, with no machine dropdown, and
Ctrl+] goes to the pane.

Failed connections show **! auth** for authentication problems or **! error** for
other failures. Click the badge, or press **!** on a machine in the dropdown,
to read the diagnostic and a suggested command. The notice stays open until
dismissed; use arrow keys or the mouse wheel to read long diagnostics.
`corgi machine status NAME` checks reachability without changing the installation.
`corgi machine reconnect NAME` opens normal SSH authentication, then verifies the
saved machine without installing, upgrading or restarting Corgi. Authentication
and host-key failures recheck every 30 seconds so an open viewer can recover
after authentication is repaired. Ctrl+R retries immediately. Host-key approval
still requires verifying the host identity. `machine check` remains the explicit
build-reconciliation command and can upgrade an installation.

Each machine retains its own workspace and pane selection. Only the selected
workspace's machine streams terminal surfaces; other machines update metadata
and resource readings without resizing panes or marking output read. Resource
sampling stays enabled across workspace switches while readings are displayed.

`corgi --machine workbox` starts on that host. `corgi --machine local` opens the
ordinary local viewer. `CORGI_MACHINE=workbox` is an optional CLI default outside
Corgi panes; an explicit `--machine` takes precedence. Switching the viewer never
retargets a running shell's commands. Remote CLI arguments and `--cwd` paths are
resolved on the remote host. `current` requires a caller pane on that host; a
local `CORGI_PANE` is deliberately not forwarded.

The aggregate list returns one result per machine, including individual errors,
and exits nonzero if any machine fails. Remote commands execute once: Corgi does
not automatically retry mutations after a timeout or disconnect. Check the host's
state before manually repeating an operation whose result was lost.

Remote launchers use the accounts configured on that host. Account sign-in and
management still run on the host itself; the remote viewer does not read or
modify matching account paths on the local computer. Local launcher profiles
are not offered for remote sessions.

## Authentication and permissions

OpenSSH authenticates both the host and the user. Adding a machine uses normal
SSH prompts and host-key confirmation. Background tunnels use `BatchMode=yes`
and `StrictHostKeyChecking=yes`: they never ask for a password, accept an unknown
host, or ignore a changed host key. They require an SSH key, an agent, or another
noninteractive SSH authentication method. Unlock encrypted keys in your SSH agent
before attaching. SSH config aliases, jump hosts and certificate authentication
remain available.

The native `corgi-remote-bridge` helper connects SSH stdin/stdout directly to the
remote daemon's private Unix socket, without starting Bun for each attachment.
Normal attachments and commands reuse a private Corgi-owned OpenSSH master;
closing a channel leaves the master available. Recovery probes, manual retries,
and bulk uploads bypass it, so a stalled master cannot trap recovery. Each
bridge direction has a bounded buffer and can progress independently.
Older profiles without a bridge path use SSH Unix-socket forwarding and require
`AllowStreamLocalForwarding`; re-add the machine to discover its bridge.
Agent forwarding, X11 forwarding and SSH `LocalCommand` are disabled.

Profiles live in `remote/machines.json` under Corgi's state directory, inside a
private directory. They contain names, SSH targets and remote paths. The daemon's
Unix socket remains its access boundary: authenticating as that user permits
control of that user's Corgi sessions, including running commands.

The viewer learns a stall budget from successful application round trips (4–30
seconds), keeping the last frame and holding typing when that budget is exceeded.
A brief hiccup recovers on the existing connection. Established RPC requests get
three times that budget; SSH authentication and the first daemon reply have a
separate 30-second allowance, including machine checks and remote listings.
A broken connection closes immediately. A lost connection is retried at once,
then after 1, 2, 4, 8 and at most 15 seconds, with a visible countdown.
A remote silent for twice its stall budget gets a second connection beside the
first, and after the computer sleeps one is tried at once. A changed network
can recover before the original request deadline, while a daemon that is only
busy keeps its connection. Cached workspaces do not mean the current viewer has
connected: initial attempts say **Connecting… 4s**, including retries before the
first success. **Reconnecting… 4s** follows a previously working link. The timer
shows time spent in the current attempt.
Numbered actions retain their replies across that handover. A worktree checkout
uses a separate connection and is not automatically replayed; if that connection
is lost, check the remote worktree before retrying.

Actions never make the viewer wait for a machine's answer. Keys typed right
after one that decides where they go, such as a split, a new agent, a rename or
closing a pane, wait for it, at most one second, then land where they would
have. A reply that arrives after you've moved elsewhere still takes effect on
the machine but doesn't move you back. If the connection goes before the reply
comes, Corgi says so: the request may have run, so check before trying again.

A machine still behind a second after a switch, a stall or a reconnect says so
on the focused pane's top rows: **work: Syncing… 2s · 3 keys waiting**, or the
stall, countdown or error instead. While that notice shows, **Ctrl+R** cancels
the current request or SSH handshake and starts a new attempt immediately,
**Ctrl+X** pauses retries, and **!** shows details. **Ctrl+C** still goes to the
agent, except before the machine has first come online, when it detaches the
viewer. These controls also work in the machine dropdown, which remains
responsive during an outage. Without the notice those keys keep their normal
meaning; open the dropdown with **Ctrl+]** to manage connections there.

Each connection carries a link the daemon keeps for ten minutes after the
connection goes, as EternalTerminal keeps a session. Typing and actions already
sent go numbered over the link: after a reconnect Corgi sends again whatever
wasn't answered, and the daemon runs each once, answering a repeat with the reply
it already had. The viewer comes back as the same viewer, with its pending
controls. Only when the link has expired, or the daemon has restarted, can a
request's outcome be unknown; Corgi then says so, and you check before repeating
it.

Typing is never dropped while a machine catches up. Keys go to the pane they
were typed into and wait there through a switch, a stall or a reconnect, and
are sent once the machine is back online, even if you've moved on to another machine. A paste interrupted
by an outage finishes after it. Keys meant for a daemon that has since been
replaced are never sent to the new one. A daemon incarnation identifies which
cached selections can be restored.
Pausing or detaching closes only the viewer's connections; remote agents keep
running. Background retries never install, upgrade or restart a remote daemon.

Workspace names, activity counts and the last resource readings are cached locally
in private files. Reopening shows these cards dimmed with **retrying**
in the machine header until fresh metadata arrives. A bright glimmer travels
across reconnecting workspace names; counts and readings remain steady.
The header keeps connection status separate from workspace controls. The cache contains no
terminal contents and grants no authority to reuse workspace IDs from a different
daemon or machine profile.

Remote viewers require the `viewer.stream` capability. Input is sent without
waiting for earlier input acknowledgements; the daemon pushes changed terminal
surfaces over the same SSH tunnel. Stream envelopes are distinct from RPC replies,
and only the latest surface per pane is retained while the UI is busy. Outstanding
input is bounded to 1 MiB and 64 writes. Heartbeats detect a silent connection even
when no one is typing. The existing runtime and viewer wire versions stay unchanged;
`viewer.stream` is a separately advertised operation using the existing view payload.

`corgi machine remove workbox` forgets the saved profile. Existing viewers read
their catalog at startup; reattach to refresh it. Removing a profile or detaching
does not stop remote agents. Revoke SSH access using your normal SSH key or
certificate policy.

Clipboard text travels over the selected connection. Supported terminal image
pastes upload the image directly over SSH and paste the resulting **remote** path.
Uploads are limited to 32 MiB and validate the image format. Clipboard operations
remain bound to the machine and pane that owned them when the paste began.

The generic RPC protocol remains version 1 and the viewer protocol remains
version 3. `hello` adds optional `viewer_protocol` and `instance` fields; remote
clients require these fields. Existing local clients remain compatible. Saved
sessions and handoffs are unchanged; no data migration is needed.
`session.snapshot` accepts an optional `resources` boolean to keep background
sampling subscribed for that connection. Older daemons ignore the field; use a
matching build on each host for continuous background readings.
`link.open` and `link.resume` are new operations, so `hello` lists them; numbered
requests add `seq` and `answered` fields that older daemons ignore. A viewer uses
links only with a daemon that lists them, and otherwise behaves as before. Handoffs
carry the links across a daemon reload: the handoff format gains `links` and each
client's `link`, both defaulting to none, so no migration is needed.

Browser access, HTTPS and browser/device pairing belong to phase two.

## Connectivity tests

`bun integration.ts remote --jobs 1` exercises actual OpenSSH and real terminal
viewers against disposable daemons. It requires `ssh`, `sshd`, and `ssh-keygen`.
The suite creates temporary keys/configuration and a userspace TCP fault proxy;
it needs no firewall changes or root access and runs on Linux and macOS.
Cases cover one-way stalls, a full network blackhole, automatic recovery,
immediate pause/retry during an RPC or SSH handshake, repeated disconnects,
independent local interaction, daemon replacement, and input and pastes held
through outages.
They also cover cached cards on reopening and compare typing echo latency with
plain SSH through the same proxy at a simulated 120 ms round trip. Unit tests check
stream/RPC ordering, stale frame rejection, input bounds and private cache handling.

For a focused recovery check:

```sh
bun build.ts --test
bun integration.ts remote --jobs 1 -- -t 'shared_master_and_failed_recovery|spotty_connection|pause_and_retry'
```

The master test first proves CLI channels share the viewer's TCP connection.
It then strands that connection, strands the next SSH handshake, and strands
the recovered connection again. Local navigation must respond within one second,
local typing must reach its pane within one second, and accepted remote markers
must appear exactly once. Input typed during the stall lands once after it.
`TcpFault.strandNext(n)` makes failed recovery handshakes reproducible without
changing the system network. Retry cancellation also has a unit regression: a
late abandoned task cannot clear or revive its replacement.

OpenSSH documents [Unix-socket forwarding](https://man.openbsd.org/ssh#L~4)
and the [client configuration](https://man.openbsd.org/ssh_config).

## Image uploads

Remote image pastes show a small bar above the caret (below it at the top of a
pane). The bar overlays the terminal without changing its layout. It follows
the visible caret as you type or wrap, and stays within the original pane.

“Preparing…” covers the host clipboard read and SSH startup. Upload percentages
come from bytes read by the remote helper, not bytes queued locally. “Uploaded”
means the remote file was saved; it does not claim that the agent has processed
the image. A failed upload shows an error. Switching machines or losing the
connection cancels the upload and removes its indicator; a paste is never replayed.

The internal `__remote-image` helper emits bounded `{"received":N}` lines before
its final `{"path":"…"}` line. Older viewers still read the final line. With an
older helper, a new viewer stays indeterminate until the final path arrives.
No daemon/viewer protocol or saved format changes are needed.

## Port and protocol compatibility

This implementation was ported from `feature/remote-ssh` onto the current
TypeScript daemon and viewer. It retains native provider UIs.
Transport is currently native stdio over OpenSSH, with Unix-socket forwarding
as a compatibility fallback; WebTransport negotiation
and direct agent presentation remain future work described in `remote-access.md`.

The current runtime and viewer protocols are both 4.
The optional `input_receipt` result and `input_ack` surface fields are additive;
older viewers ignore them. Receipts are ephemeral and do not change saved formats.
Correlated request IDs belong to one connection; link sequence numbers survive
reconnects. Cached replies acquire the new request ID when replayed, and only
contiguous acknowledgments release cached results. Links and streaming are
additive capabilities; new handoff fields default to
empty state when absent. Use matching builds on the two machines for remoting.
