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
small machine label on each row. Click any workspace or use the ordinary
workspace keyboard navigation to open it. Connecting or disconnected workspaces
stay visible but dimmed; local work remains usable during a remote outage.
With **agents: all**, the agent list shows every online machine's agents, each
workspace's header naming its machine. Clicking one, or moving to it with the
agent keys, opens it on its machine; folding a group folds it on that machine.

Once a remote machine has connected, **all ▾** appears beside **workspaces**.
Click it, press **Ctrl+]**, or use **prefix + Shift+M** for a dropdown of machines
and connection status. Arrows and Enter filter the list; Escape closes it.
Ctrl+R cancels the highlighted machine's current request or connection attempt
and retries immediately. Ctrl+X pauses it and stops automatic retries. A machine
stays in the dropdown through outages so these controls remain available.
Local-only Corgi has the same header as before, with no machine dropdown, and
Ctrl+] goes to the pane.

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

After a request stalls for one second, the viewer keeps the last frame, shows
**Connection stalled**, and pauses input. A brief hiccup recovers on the existing
connection. RPC requests time out after ten seconds; a broken connection closes
immediately. A lost connection is retried at once, then after 1, 2, 4, 8 and at
most 15 seconds, with a visible countdown. SSH setup has its own bounded timeout.
A remote machine silent for four seconds gets a second connection beside the
first, and after the computer sleeps one is tried at once: a changed network
recovers without waiting out the ten-second timeout, while a daemon that is only
busy keeps its connection. Numbered actions retain their replies across that handover. A worktree checkout
uses a separate connection and is not automatically replayed; if that connection
is lost, check the remote worktree before retrying.

Actions never make the viewer wait for a machine's answer. Keys typed right
after one that decides where they go, such as a split, a new agent, a rename or
closing a pane, wait for it, at most one second, then land where they would
have. A reply that arrives after you've moved elsewhere still takes effect on
the machine but doesn't move you back. If the connection goes before the reply
comes, Corgi says so: the request may have run, so check before trying again.

While input is paused, **Ctrl+R** cancels the current request or SSH handshake and
starts a new attempt immediately, **Ctrl+X** pauses retries, and **Ctrl+C** detaches
the viewer. These controls also work in the machine dropdown, which remains
responsive during an outage. On a healthy terminal those keys keep their normal
meaning; open the dropdown with **Ctrl+]** to manage connections there.

Each connection carries a link the daemon keeps for ten minutes after the
connection goes, as EternalTerminal keeps a session. Typing and actions already
sent go numbered over the link: after a reconnect Corgi sends again whatever
wasn't answered, and the daemon runs each once, answering a repeat with the reply
it already had. The viewer comes back as the same viewer, with its pending
controls. Only when the link has expired, or the daemon has restarted, can a
request's outcome be unknown; Corgi then says so, and you check before repeating
it.

Input not yet sent is discarded when a stall is detected or a machine is
switched; nothing typed against a stalled screen is sent later. Typing before
the first screen appears goes to the machine Corgi opens on, once its screen is
up. An interrupted
paste cannot continue into a new connection. Input resumes only after a fresh
terminal sync has been displayed. A daemon incarnation identifies which cached
selections can be restored.
Pausing or detaching closes only the viewer's connections; remote agents keep
running. Background retries never install, upgrade or restart a remote daemon.

Workspace names, activity counts and the last resource readings are cached locally
in private files. Reopening shows these cards dimmed with a connection link (`↔`)
until fresh metadata arrives. A bright glimmer travels across the workspace name,
machine name and link; counts and readings remain steady. A fixed link slot keeps
all content in place through every connection state. Paused or incompatible
connections have a static `×` indicator. The cache contains no
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

## Instant typing

**Predictive Rendering** is on by default in Corgi setup → **Remote**. Corgi
previews ordinary ASCII text, backspace, delete and left/right cursor movement
in a recognized Codex or Claude composer. A recognizable draft or dim placeholder
can start immediately, without a training edit. An unstyled placeholder waits
until the first real draft arrives. Words wrap using the agent's own input width,
and edits preserve known soft wraps. The agent still owns the native input box.
Local panes use their ordinary input path.

Turn it off to always wait for the remote screen, or use
`corgi --machine workbox action instant-typing off` (`auto` turns it back on).
The choice applies across machines in this viewer and persists for new viewers.

This is conservative prediction, not an acknowledgement from the agent. Incoming
screens confirm pending edits or immediately replace a wrong prediction. It does
not predict submit, history/word navigation, paste, Unicode text, completion menus, or layouts
it cannot recognize. Existing multiline drafts cannot reliably reveal their hard
and soft breaks; prediction starts from a simple single-line draft and tracks its
wraps. Completion tokens such as `@file` pause the preview while being edited;
literal punctuation elsewhere does not disable the whole draft. Closing a popup
and receiving a matching plain composer resumes preview without retraining,
including for a draft whose soft wraps are already known. Ambiguous cursor
positions wait for a later edit to distinguish them. Uncertain URL/hyphenation
wrapping also uses remote echo.

Unconfirmed previews expire after 750 ms, even if typing continues. Disconnect,
machine/pane changes, scrolling, selection, resize and agent replacement discard
them. Previews never modify the real terminal, copied text or input queue, and
never cause input to be replayed. Old and new daemons use the same wire protocol;
this feature is entirely in the viewer. The new `instant_typing` viewer preference
defaults to `auto` in older preference files; no saved-session migration is needed.

## Connectivity tests

`bun integration.ts remote --jobs 1` exercises actual OpenSSH and real terminal
viewers against disposable daemons. It requires `ssh`, `sshd`, and `ssh-keygen`.
The suite creates temporary keys/configuration and a userspace TCP fault proxy;
it needs no firewall changes or root access and runs on Linux and macOS.
Cases cover one-way stalls, a full network blackhole, automatic recovery,
immediate pause/retry during an RPC or SSH handshake, repeated disconnects,
independent local interaction, daemon replacement, and discarded input/pastes.
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
must appear exactly once. Input typed after the stall is shown must not arrive.
`TcpFault.strandNext(n)` makes failed recovery handshakes reproducible without
changing the system network. Retry cancellation also has a unit regression: a
late abandoned task cannot clear or revive its replacement.

`src/instant_input.test.ts` compares wrap/unwrap behavior with sanitized terminal
captures from Codex 0.162.1 and Claude Code 2.1.296, including their different
full-line cursors and long-word handling. It covers corrections, coalesced frames,
ambiguous acknowledgements, expiry, reconnect/resize, unsupported input and copy/
replay isolation. The SSH suite replays these captures in a real PTY behind 240 ms
round-trip delay and withheld responses, testing local wrap/unwrap, the off switch
and automatic recovery without duplicate input. No model calls are needed.

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
TypeScript daemon and viewer. It retains native provider UIs and conservative
Codex/Claude typing prediction. Other providers use authoritative remote echo.
Transport is currently native stdio over OpenSSH, with Unix-socket forwarding
as a compatibility fallback; WebTransport negotiation
and direct agent presentation remain future work described in `remote-access.md`.

The current runtime and viewer protocols are both 4.
Correlated request IDs belong to one connection; link sequence numbers survive
reconnects. Cached replies acquire the new request ID when replayed, and only
contiguous acknowledgments release cached results. Links and streaming are
additive capabilities; new handoff fields default to
empty state when absent. Use matching builds on the two machines for remoting.
