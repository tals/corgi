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
the same row. Setup → Remote → Predictive Rendering's **On (dim unacknowledged typing)**,
the default, shades the preview gray until confirmed.

Latency is one-way, so 1000 ms adds at least two seconds to authoritative echo.
The fake agents have bounded multiline composers: arrows move the caret,
Backspace/Delete edit around it, and Shift/Alt+Enter insert newlines. Their key
parser handles split escape sequences and bracketed pastes. Recognized composers
can predict the first edit without the shell's echo-training step.

**Prefix + ~** opens developer connectivity on any machine, including real ones.
The split console lists machines under **Remote** on the left. Click a machine,
or use Up/Down in the list. Tab switches between the list and details; Escape
closes the console. The right side shows response time as mean ± standard deviation
with its peak, traffic averaged over five seconds, request counts, and a two-minute
response heatmap. Fixed latency bands keep spikes from changing
the scale; brighter cells mean more replies in that band and time slice. Dark
cells mean none. A separate amber row counts failed requests. Time slices stay
aligned to the clock.
Values use milliseconds or seconds for readability.
Scroll the detail panel (or use Page Up/Down) to reach controls on short terminals.
RPC latency includes daemon work; it is not ICMP ping. History survives reconnects.
Successful application round trips adapt stall and fresh-path probe budgets to latency and jitter;
failed requests, SSH bootstrap time and replies spanning a detected stall do not
inflate them. A slow link can stay online while it continues making progress.
Traffic counts protocol bytes, excluding SSH overhead and independent bulk uploads. Failed requests include cancellation and closure, not just timeouts.

Drag workspace names to arrange any mix of local and remote workspaces. Small
machine headers repeat wherever ownership changes, including after scrolling.
Hover over a machine header for one second to see that machine's summary and
history without opening the developer console. This card uses measurements
already held by the viewer, including during an outage.
The shaded headers show reception bars for remote links. The rating combines
response time and variation, recent interruptions, and delayed delivery. Recent
failures cap the rating even when successful replies are fast. Outages lower it
immediately; ordinary deterioration must persist for three seconds, and an
improvement for ten. Interruptions remain relevant for thirty seconds.
These describe application responsiveness and reliability, not wireless signal
or measured bandwidth capacity. Local machines omit the bars.
Kitty-capable terminals use pixel bars with a one-pixel gap between cells;
other terminals use block glyphs. While reconnecting, **retrying** replaces them.
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
