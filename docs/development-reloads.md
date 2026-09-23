# Developing Corgi inside Corgi

The work is split into three commits/milestones. Stop after each milestone for a
manual restart and user check before continuing.

1. **Runtime interface (complete).** Session resources live in
   `runtime.zig`; protocol 1 exposes session data and terminal surfaces separately
   from presentation. This initially retained the daemon-rendered UI, which has since been removed. This milestone does not change viewer focus behavior or enable handoff.
2. **Viewer-owned UI (complete).** Composition, menus, dialogs, and interaction run in
   the viewer. Workspace/tab order and split arrangement remain shared. Selected
   workspace, selected tab, focused pane, and transient presentation state belong
   to each viewer. Keep selection by ID and reconcile it when another viewer
   closes or moves its target. PTY sizing must account for which panes each
   viewer actually displays; a hidden viewer selection must not steal input or
   resize unrelated panes.
3. **Live daemon handoff and cold recovery (this milestone).** Drain accepted writes, pause I/O, transfer PTYs and
   native-session pipes to a replacement executable, restore state, commit
   ownership, and preserve connected viewers. Preserve process IDs; rollback before
   commit on failure. Never turn a failed reload into a destructive restart.

Normal shutdown terminates processes; the next startup now recovers saved context in new shells. An already-running old
daemon cannot gain export support just because a new executable has been built.

## Protocol 1

The Unix socket still accepts newline-delimited JSON. Existing operations retain
their behavior. New operations require either `"protocol":1` on each request or
an earlier `{"op":"hello","protocol":1}` on the same connection. The hello
reply includes `protocol`, `server_pid`, and a list of supported operation names
in `capabilities`. Unsupported versions are rejected before performing operations.
Future viewers must negotiate capabilities, tolerate additional response fields,
and treat missing capabilities as unavailable rather than restarting the daemon.

Examples (these inspect/control the selected `CORGI_SOCKET`):

```sh
corgi rpc '{"op":"hello","protocol":1}'
corgi rpc '{"op":"session.snapshot","protocol":1}'
corgi rpc '{"op":"pane.surface","protocol":1,"pane":1}'
```

| Operation | Required target/data | Result |
| --- | --- | --- |
| `session.snapshot` | None | A `type: "session"` snapshot |
| `session.subscribe` | None | Initial session snapshot, then coalesced replacement snapshots |
| `pane.surface` | `pane` | A `type: "surface"` response |
| `pane.input` | `pane`, `data` string | Write the supplied terminal bytes to that pane |
| `pane.create` | `workspace` | Create a tab and return `pane` without selecting it |
| `pane.split` | `pane`, `axis: "right"` or `"down"` | Split that pane and return the new `pane` without selecting it |
| `pane.close` | `pane` | Close that pane and retain its closed-output snapshot |
| `tab.rename` | `tab`, `title` | Rename that tab; empty title restores automatic numbering |
| `split.resize` | `pane`, `direction: "left"`, `"right"`, `"up"`, or `"down"` | Adjust the enclosing split without changing selection |

Creation accepts optional `cwd`, `command`, and `title`; the workspace directory
is the default. Pane input is already-encoded terminal input, not UI shortcuts,
paste wrapping, or automatic keyboard-protocol translation. It requires an
explicit target on every request. A future viewer must hold the starting pane ID
for the duration of a bracketed paste.

Session snapshots include stable workspace/tab/pane IDs, names, directories,
split trees, pane PIDs and sizes, agent metadata, native sessions, and the number
of retained closed panes. A split tree contains either `{"pane":ID}` or
`{"split":{"axis":"horizontal"|"vertical","ratio":500,"first":NODE,"second":NODE}}`.
Ratios are thousandths. No selected workspace/tab/pane or zoom state appears in
this shared snapshot. Viewers keep their own selection models.

Snapshots carry `server_pid` and a runtime `revision`. Revisions can skip and
include output/presentation invalidations; clients replace the snapshot rather
than interpreting them as a durable event log. A subscription does not attach a
viewer, create a shell, or change sizing/focus. It remains open across idle
periods. Slow subscribers get coalesced updates after their pending message is
flushed. Reconnect and obtain a new initial snapshot after connection loss.
The one-shot `corgi rpc` CLI reads only the first reply; subscriptions require a
persistent socket client. Do not mix subscriptions with `viewer.open`.

Surface responses carry the same server/revision fields and a `surface` object:
`pane`, `cols`, `rows`, `lines`, and a nullable zero-based `{x,y}` cursor. Each line
contains SGR-styled terminal text, starts with its own style, and ends in SGR
reset. It contains no cursor movement or surrounding Corgi UI. The viewer places
these lines and controls cursor visibility. The surface is the latest completed
Ghostty render (possibly empty before the first completed synchronized redraw).
This original operation uses the terminal's default scroll viewport. Normal viewers
use `viewer.sync`, which captures their independently requested viewport. Reading a surface does not select or acknowledge the pane.

## Terminal restoration findings

`src/checkpoint_probe.zig` characterizes the pinned Ghostty formatter through
in-memory replay into a fresh terminal. It is test-only, not a live checkpoint
implementation.

- With all formatter extras, retained primary history can exceed 8 KiB and
  replay with current input modes and keyboard flags. The handoff need not copy
  Herdr's 8 KiB truncation.
- Global extras such as tabstops can move the replay cursor after the screen
  formatter restores it. The probe restores cursor coordinates last, using the
  default origin mode; non-default origin/margins still need validation.
- Formatting the active alternate screen preserves its contents and active
  mode, but omits the inactive primary screen. Handoff needs both screens.
- Current Kitty keyboard flags survive, but the push/pop stack does not.
- A partial escape such as `ESC [ 31 ;` is not part of formatted terminal state.
  Passing the remainder to a fresh parser corrupts its interpretation.

Milestone 3 must preserve both screens, keyboard stack, and incomplete parser
input (including UTF-8 and OSC/DCS), or explicitly reject a handoff that cannot
be restored safely. A text/ANSI dump alone is insufficient. Validate cursor
save/restore, wrapping, origin/margins, colors, resize, native request buffers,
and imported-child exit detection as part of that milestone.

## Milestone 1 manual check

After saving work, run `./go.sh --restart` from outside Corgi. This is an ordinary
restart and ends the existing runtime's panes. Check tabs/splits, tab dragging
and rename, workspace switching, enhanced keyboard input, paste, wheel scroll,
mouse selection, agent indicators, and detach/reattach. Multiple viewers still
share selection in this milestone. The new independent selections arrive in 2.


## Milestone 2: local viewers

After the one-time daemon upgrade, rebuild and open `./go.sh` to pick up UI changes.
The daemon PID and all existing pane processes stay the same. Viewer-only changes
include menus, dialogs, key bindings, sidebar composition, and presentation. A
feature needing a new runtime capability uses the live daemon handoff below.

The viewer instantiates `controller.zig` with a private `mirror.zig`
projection. That projection creates Ghostty framebuffers, never processes or
PTYs. Session snapshots rebuild shared arrangement while retaining selected IDs
and zoom locally. A removed selection falls back to a surviving pane/tab or the
first remaining workspace. Menus targeting removed tabs and stale divider drags
are cancelled. Shared layout versions exclude focus, zoom, and terminal output.

The additive protocol capabilities are:

- `viewer.open`: establish a viewer on a persistent negotiated connection.
- `viewer.sync`: report visible pane IDs, requested sizes, scroll offsets, focus,
  workspace, and watch state; receive session data, pane surfaces/input modes,
  pending sequenced CLI controls, and sound events. Controls remain pending until
  the viewer acknowledges applying them; back-to-back focus/split commands retain
  their intended target. Creation returns `ViewerBusy` when a queued local action
  must resolve the target first. No composed Corgi frame crosses the wire.
- `layout.apply`: apply shared tab names/order, swaps, and split ratios against an
  expected structural token. Pane/tab identity sets must remain unchanged.
  Conflicts refresh the viewer and ask it to repeat the edit.
- `pane.transfer`, `pane.restore`, `pane.acknowledge`, `workspace.create`: explicit
  shared operations needed by the UI. These never set another viewer's selection.
- `viewer.search`: locate text in retained terminal history without changing a
  shared viewport. Selection and clipboard formatting remain local.
- `viewer.list`: inspect IDs and last reported selections for targeting CLI actions.

A pane is sized only by viewers showing it; hidden panes retain their last size.
Views of the same pane use the minimum requested dimensions. Scroll offsets,
selections, and paste targets are local. Input batching keeps a bracketed paste
bound to its starting pane even if navigation changes; closing that pane discards
its remaining input. Renderer captures restore the terminal viewport after sampling.
The daemon no longer accepts the former `attach`, `input`, or `size` operations.

### Manual check

Save work, then run `./go.sh --restart` from outside Corgi once to install this
protocol. Open two outer terminals with `./go.sh`. Navigate different tabs and
workspaces; open a menu/dialog and scroll in one while using the other. Rename,
reorder, split, and close panes and verify both see the same arrangement while
keeping their own selections. Resize one viewer while viewing different panes,
then the same pane. Detach and reopen one viewer: the other and its running
processes should continue. Check enhanced keyboard input, paste, mouse selection,
search/copy, agent attention, and sounds.

Validation uses the existing real-PTY smoke suite plus `tests/viewers.py`, which
runs the same controller/transport through a deterministic stdio harness enabled
only by `-Dviewer-test-driver=true`. Normal builds exclude the harness entry point.


## Milestone 3: live handoff and recovery

`./go.sh --reload` builds and replaces the daemon, including when invoked inside
one of its panes. It returns after the handoff; it does not open a nested viewer.
`corgi reload [ABSOLUTE_EXE]` reloads an existing build. The daemon queues the
request until the current input slice completes, drains accepted terminal/native
writes, and stops polling. A forked candidate execs the new binary with an
allowlist of inherited PTYs, native pipes, client sockets, listener, anonymous
manifest file, and private handshake socket. Fork inheritance provides the FD
transfer; it does not fork or restart the pane processes.

The candidate reconstructs and validates all state before reporting ready. It
cannot perform process I/O until the source sends commit. Before commit, a bad
binary, incompatible checkpoint, timeout, replay failure, or backpressure kills
only the candidate and resumes the source. On commit the source exits without
running process-killing destructors or unlinking the listener. The new daemon
uses PTY/pipe EOF and process checks for children it cannot waitpid. Normal viewer
sockets, buffered requests/replies, pending controls, and acknowledgements survive,
so viewer instances keep all their local state without reconnecting or retrying
mutations.

Live terminal export uses compact VT snapshots of retained history, screens,
cursor, and input modes rather than accumulated output journals. Restoration
suppresses PTY replies until commit; after commit a temporary width change and
restore 250 ms later request an application repaint. Parser fragments, keyboard
stacks, and some saved terminal state are approximate, and applications that do
not repaint may retain artifacts. Older exact replay checkpoints remain supported
on import. A terminal dependency fingerprint rejects incompatible engines.
Manifests remain limited to 256 MiB and restoration must finish within the
15-second candidate readiness timeout. The old daemon continues serving when
handoff is unavailable. An already running daemon still uses its original exporter;
rebuilding alone cannot unblock an old exporter over its manifest limit.

Disk recovery is intentionally different: every two seconds when changed, before
handoff, and on clean shutdown, save a versioned snapshot atomically (fsync plus
rename). `corgi checkpoint` forces a save and prints its location. Files are mode
0600 inside a mode-0700 recovery directory under XDG_STATE_HOME or HOME, keyed by
socket path; the default runtime's file survives `/tmp` cleanup. A malformed or
unsupported saved file fails startup instead of being overwritten by an empty
session. Recovery restores arrangement, IDs, directories, retained output, and
recorded agent IDs. New shells show explicit resume commands; no saved input,
old launch command, pending approval, or agent command is automatically executed.
Native transports restore as archived sessions plus recovery shell tabs. Existing
shell history files remain the shell's responsibility. Missing directories use
HOME and retain the original path in the pane's recovery banner.

### Manual check

The currently running milestone-2 daemon cannot export live state. Save work and
perform one ordinary `./go.sh --restart` from outside Corgi to install export
support. Then open two viewers, put a long-running command or agent in a pane,
and run `./go.sh --reload` from another pane. The daemon PID should change while
pane PIDs, viewer selections, scrollback, input, menus, and agent sessions survive.
Repeat with different panes visible and after resizing. Try a nonexistent binary
with `corgi reload /does/not/exist`; the old runtime should remain usable.

For a cold recovery check in a disposable runtime, change a pane's directory,
produce recognizable output, and run `corgi checkpoint`. Stop that test runtime
and start it again. Its saved layout and output should return with new shell PIDs,
the saved directory, and a resume command for any recorded agent session. Closing
a pane intentionally removes it from the next recovery snapshot.

Validation: `./scripts/zig build test`, then
`./scripts/zig build -Doptimize=ReleaseSafe -Dviewer-test-driver=true`,
`python3 tests/smoke.py`, `python3 tests/viewers.py`, and `python3 tests/reloads.py`.
All process tests use isolated sockets, HOME/state directories, and provider doubles.
