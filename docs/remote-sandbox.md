# Remote connectivity lab

Run `./go.ts --sandbox remote` (or add `--restart` for a fresh world). It needs
local `ssh`, `sshd` and `ssh-keygen`. No root access or host network changes are
needed. Local, atlas, borealis and cirrus run actual Corgi daemons; the three
synthetic remotes connect through OpenSSH and separate loopback fault proxies.
Builder output, fake working agents and interactive shells keep the world busy.
No model calls or real remote hosts are involved.

**Prefix + ~** opens developer connectivity on any machine, including real ones.
Tab or clicking the machine name cycles machines; Escape closes it. The popover
shows RPC latency mean/deviation and peak, failures, pending requests, connection
attempts, traffic rates and a scrolling history. RPC latency includes daemon work;
it is not ICMP ping. History covers up to two minutes in this viewer and survives
reconnects. It also shows the current stall and fresh-path probe budgets.
Successful application round trips adapt these budgets to latency and jitter;
failed requests, SSH bootstrap time and replies spanning a detected stall do not
inflate them. A slow link can stay online while it continues making progress.
Traffic counts protocol bytes, excluding SSH overhead and independent bulk uploads. Failed requests include cancellation and closure, not just timeouts.

Drag workspace names to arrange any mix of local and remote workspaces. Small
machine headers repeat wherever ownership changes, including after scrolling.
The combined order is saved on this computer and can be changed during an outage.

Sandbox machines also show sliders for one-way latency (0–2000 ms), bandwidth
per direction per SSH connection (0–4096 KiB/s, zero unlimited), and outage
duration (0–60 seconds).
Click or drag a slider, or select it with Up/Down and adjust with Left/Right.
Enter activates the selected button. Start outage withholds traffic while keeping
connections open, exercising stall detection; Drop connections now severs current
connections, exercising reconnect. Reset restores healthy, unrestricted traffic.
Already queued bytes retain their scheduling deadline when settings change.
Real machines have diagnostics only and gain no fault-injection buffers.

The sandbox introduction prints its private control socket. From another shell:

```sh
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock status
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock set atlas --latency-ms 120 --bandwidth-kib 128
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock outage atlas 8
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock drop atlas
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock reset all
```

Inside a sandbox shell, `CORGI_REMOTE_LAB` supplies the socket, so `--socket` can
be omitted. Responses are JSON. CLI updates appear in the popover; its controls
use the same API. `all` applies a fault to all three synthetic remotes, never local.
The API rejects invalid names, nonfinite numbers and out-of-range values.

Keep the **network supervisor** pane open. It owns SSH, the remote daemons and
fault proxies; closing it or stopping the sandbox shuts them down. Detaching the
viewer keeps the sandbox running. If the supervisor was closed, use `--restart`
to recreate the lab. Each remote has its own home, socket and state directory.

Validation: `bun build.ts --test`, then
`bun integration.ts remote_sandbox --jobs 1`. This exercises actual daemon and
SSH startup, the popover, mouse and CLI fault controls, and supervisor cleanup.
The broader `remote` integration suite covers stalled masters and recovery races.
