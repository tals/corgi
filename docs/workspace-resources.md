# Workspace resources

Each workspace's third sidebar row shows current CPU (`C`), physical memory
(`M`), and disk read + write throughput (`↕`). Unavailable metrics are omitted,
including their labels. A real zero is still displayed. A thin separator runs
under the readings between workspaces. A trailing `›` marks rows with hover
details, and the row immediately highlights on hover, staying highlighted while
the pointer is in its card. All three rows select the workspace on
click, including when a resource card overlaps them on a narrow screen.

Hover the resource row for 500 ms to open three framed history graphs and the
process table, with separate PID and executable-name columns. No process activity
descriptions or inference requests are generated. Click CPU, memory or I/O table
headers to sort. Recognized agent executables carry `*` for Claude Code and `†`
for Codex, with a plain legend below the table; raw executable names are retained.
The pointer can cross the sidebar divider into the card. Entering it freezes
row identities while values keep updating. The card is local to that viewer
and is hidden if all data is unavailable.

One daemon worker samples every two seconds, or every second while any watched
viewer has a resource card open. The worker uses native macOS process APIs or
Linux `/proc`, without starting `top`, `btop`, `ps`, or another helper. Normal
viewer snapshots contain totals; process details and history are sent only for
the requested workspace. Histories retain 48 samples, and a bounded union of the
leading CPU, memory and I/O consumers is retained for sorting.

Corgi setup has one on/off control for resource readings. Hover details are always
available when readings are on; there is no separate hover setting. Off removes the
row: each workspace takes two rows, with the separator under its status. Once no
attached viewer shows readings, the worker stops and its readings are discarded.
It stays stopped after those viewers detach, until a viewer shows readings again.

CPU percentages use one core as 100%. macOS CPU counters are converted from Mach
ticks using the host timebase. Memory is summed physical footprint on macOS and
summed RSS on Linux; it is an estimate, and shared mappings can overlap. Disk
rates are attributed disk bytes, not logical file reads or network I/O.

CPU turns amber after ten seconds with host utilization at least 90% and the
workspace using at least 25% of host CPU capacity. It clears after thirty seconds
below 75% host utilization or 15% workspace share. Memory turns amber after ten
seconds of host memory pressure with at least 15% of host RAM attributed to the
workspace, and clears after thirty seconds of normal pressure or less than 10%
of RAM. These are conservative heuristics, not direct per-workspace stall
measurements. High disk throughput does not trigger a pressure alert.

Pane roots, native agent sessions, and their descendants are attributed by
process ancestry. PID/start-time identity prevents deltas from crossing PID
reuse or workspace changes. Short-lived processes between samples, detached or
reparented processes, and remote/container workloads can escape attribution.
Workspace rates sum the available process deltas; new processes contribute after
their second sample. A failed process read leaves partial totals from the other
processes. A metric stays unavailable when no process has a valid reading, and
only a confirmed empty workspace reports zero for every metric. No dedicated
Linux cgroups are created by this feature.
