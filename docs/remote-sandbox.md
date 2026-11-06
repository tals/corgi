# Remote connectivity lab

Run `./go.ts --sandbox remote` (or add `--restart` for a fresh world). It needs
local `ssh`, `sshd`, `ssh-keygen`, Claude Code and Codex. No root access or host network changes are
needed. Local, slowloris, finnicky and goodboy run actual Corgi daemons; the three
synthetic remotes connect through OpenSSH and separate loopback fault proxies.
Every machine has an interactive shell, a working fake agent (one progress line
every eight seconds), **idle Claude** and **idle Codex** tabs running the real
terminal apps, and a
quiet demo server with a live HTTP link. Slowloris starts with 800 ms one-way lag;
goodboy with 100 ms. Finnicky holds traffic for five seconds every thirty seconds
(start to start), leaving TCP connections open. Local has no injected faults.
The idle apps use disposable homes and local fake API backends, with onboarding
and workspace trust already configured. No login or paid model calls are needed.
Each backend answers with a canned sandbox reply; the input boxes, key handling
and rendering are the installed apps' own. Their helper owns the backend and
Codex app server, and closes them with the tab. No real remote hosts are involved.

To try Predictive Rendering, type a character in a shell, `cat`, or the fake
agent's sign-in prompt and wait for its remote echo. Start with a nonblank ASCII
character; further typing and ordinary editing within the learned line appear locally.
Unsupported controls and mismatches reset this training. Confirmed echo can retrain on
the same row. Setup → Remote → **Dim unconfirmed typing** shades the preview gray
until confirmed and is on by default.
Latency is one-way, so 1000 ms adds at least two seconds to authoritative echo.
The fake agents have bounded multiline composers: arrows move the caret,
Backspace/Delete edit around it, and Shift/Alt+Enter insert newlines. Their key
parser handles split escape sequences and bracketed pastes. Recognized composers
can predict the first edit without the shell's echo-training step.

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
per direction per SSH connection (0–4096 KiB/s, zero unlimited), hang duration (0–60 seconds), repeat interval (0–120 seconds, zero disables
repeats), and one-shot outage duration (0–60 seconds). Changing either repeat
control restarts its countdown. A duration longer than the interval keeps traffic
held continuously until the policy changes.
Click or drag a slider, or select it with Up/Down and adjust with Left/Right.
Enter activates the selected button. Start outage withholds traffic while keeping
connections open, exercising stall detection; Drop connections now severs current
connections, exercising reconnect. Reset restores healthy, unrestricted traffic and disables repeating hangs.
Already queued bytes retain their scheduling deadline when settings change.
Real machines have diagnostics only and gain no fault-injection buffers.

The sandbox introduction prints its private control socket. From another shell:

```sh
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock status
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock set slowloris --latency-ms 120 --bandwidth-kib 128
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock set finnicky --hang-seconds 5 --hang-every-seconds 30
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock outage slowloris 8
bun tools/remote_sandbox.ts --socket /tmp/corgi-sandbox-$UID/remote/network.sock drop slowloris
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
