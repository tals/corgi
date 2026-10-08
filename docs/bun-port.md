# From Zig to Bun

Corgi was written in Zig through October 2026. It is now a Bun application:
the daemon, viewer and CLI are TypeScript in `src/`, and a small native
layer in `native/` keeps the parts that need it, built from Ghostty and
the Zig sources in `native/zig/`: terminal emulation, frame diffs,
keyboard encoding, PTYs, process checks, crash reports and the
`corgi-hook` sender.

The Zig application is on the `archive/corgi_v0_zig` branch. Its last
commit holds the work that was in progress at the switch.

## How the port matches Zig

The TypeScript modules are line-by-line ports of their Zig files, with the
Zig tests ported beside them. Text is measured the way Zig measured it:
`text.ts` stands in for `std.Io.Writer`, and display widths come from
Ghostty's codepoint table in the native library.

The port followed Zig through `330806c` ("launcher: show the model Claude
Code picks by default").

## Comparing against Zig

`tools/probe.ts` runs a viewer in a PTY with isolated state, renders its
output through Ghostty, and compares two binaries screen by screen. Its
scenarios in `tools/scenarios/` cover the launcher, popups, help,
onboarding, setup, workspaces, tabs, splits, menus, copy mode and paste,
mouse drags, agents (with fake hook-driven `claude`/`codex` on PATH), hover
cards, tab-bar scrolling and idle output rates.

To compare against Zig, build the archived Zig application and point the
probe at it:

```sh
git worktree add ../corgi-zig archive/corgi_v0_zig
(cd ../corgi-zig && ./scripts/zig build -Doptimize=ReleaseSafe)
bun build.ts
bun tools/probe.ts suite --left zig/bun   # PROBE_ZIG overrides ../corgi-zig
```

`zig/bun` is the Zig viewer on a Bun daemon, so differences are the
viewer's. The comparison masks what changes with the clock or the sampler:
CPU and memory readings, spinners, the corgi's animations and temporary
paths (`PROBE_EXACT=1` turns that off). The suite runs four scenarios at a
time (`PROBE_JOBS`) and reruns a mismatch alone before calling it a failure.
