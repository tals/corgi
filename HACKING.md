# Working on Corgi

## Get running

Install Bun and use the pinned Zig 0.16.0 wrapper, `./scripts/zig`.
Start in an isolated environment:

```sh
./go.ts --env dev
```

This builds `dist/corgi` and starts or attaches to the named runtime. Its
preferences and recovery state persist. `--temp` gives each invocation fresh
Corgi state and stops your older temporary runtimes, including their panes and
agents. Use `--temp --no-kill` to keep them. Detaching leaves either runtime
running. Provider accounts and import sources are still shared. Use a sandbox
for fake agents.

Plain `./go.ts` uses the main environment and stops your other Corgi daemons.
`--no-kill` skips this cleanup too.
Inside a named environment it keeps that environment. Run environment-switching
commands from an outer terminal; `./go.ts --help` describes the options.

## Architecture

The daemon owns processes, PTYs, workspaces and conversations. Viewers compose
the UI from snapshots and terminal surfaces; each keeps its own focus, menus,
scroll position and selection. CLI and viewer mutations use the same commands.

| Concern | Start here |
| --- | --- |
| Daemon and shared state | [server.ts](src/server.ts), [runtime.ts](src/runtime.ts), [session.ts](src/session.ts) |
| Viewer and actions | [controller.ts](src/controller.ts), [action.ts](src/action.ts), [viewer_protocol.ts](src/viewer_protocol.ts) |
| Provider observations | [agents guide](docs/agents.md), [conversations.ts](src/conversations.ts) |
| Native terminal, PTYs and rendering | [native/](native/), [native_bridge.ts](src/native_bridge.ts) |
| Persistence and handoff | [persist/](src/persist/) |

Shared layout contains arrangement, not viewer navigation. A pane takes the size
requested by its most recently active viewer; hidden panes retain their size.
Background workers return observations for the daemon to validate and apply.
Keep application policy in TypeScript and the native boundary small.

Pane surfaces carry Kitty image placements; `viewer.image` transfers decoded
pixels in bounded chunks. [pane_images.ts](src/pane_images.ts) gives each viewer
its own image ids, clips pictures to their panes and frees images that leave
the screen. Pictures sit above text, so `render.frame` places them last, cut
around the cards and menus drawn over them, and only while their pane isn't
dimmed. This supports static RGB/RGBA and PNG images sent directly or by local
file. Unicode placeholder placements, animation, Sixel and iTerm2 image
commands are not forwarded. The host must support Kitty graphics and report its
cell pixel size. The added surface fields and cell-size hint are optional, so
wire versions and saved formats are unchanged; older viewers continue to
receive text. `./go.ts --sandbox images` shows a picture to open cards over.

`terminal_info.ts` owns live terminal state and separates replies from typed
input. The viewer and daemon keep its plain snapshot, including `Probe.info`,
without report formatting. `bug_report.ts` interprets that data only when a
report is requested. Its reader also accepts the older `answers` payload.
The cached terminal JSON now carries optional `info`; required wire fields and
saved formats are unchanged. Older report readers still show the common
terminal metadata but do not interpret the new measurements.

Raster drawing requires Kitty graphics support and a measured cell size.
Terminal information prefers the terminal's cell-size reply, with PTY pixels
and a window-size reply as fallbacks, and asks again on resize. Without a usable
size, the viewer keeps text and emoji fallbacks. The sidebar badge is resized
with `Bun.Image` and displayed at its native pixel size, like thumbnails and
tab icons, without terminal-specific scaling commands.

Agent-derived tab labels keep Unicode names, including emoji, while replacing
terminal controls with printable placeholders. Tabs measure and clip labels in
Ghostty display cells, keeping combining marks with their base character.
This is display-only; saved-name rules and wire formats are unchanged.

The binary bundles two native shared libraries: `corgi_term` owns Ghostty
terminal emulation, rendering, frame diffs and input encoding; `corgi_system`
owns POSIX/PTY helpers, process inspection, resource sampling, descriptor
readiness and crash reporting. Loading the system library does not initialize
crash reporting; the application enables it explicitly. `pty-exec` and
`corgi-hook` remain separate helper executables.

## Build, test and format

```sh
bun build.ts --no-native      # TypeScript-only rebuild
bun test src                 # unit tests
bun typecheck.ts             # types and formatting
bun format.ts                # format TypeScript
bun build.ts --test          # dist/corgi-test
bun integration.ts           # process, socket and PTY suites
```

Use `bun build.ts` when native code changes. Iterate with a focused unit test or
named integration suite, then run the full unit suite and relevant integrations.
If a parallel integration suite fails, rerun it with `--jobs 1` first.
`bun integration.ts --check` only parses and bundles suites; it does not run them.

[AGENTS.md](AGENTS.md) owns coding and commit conventions.
[tests/README.md](tests/README.md) explains test tiers, isolated runtimes and
deterministic waiting. [evals/README.md](evals/README.md) covers activity-summary
evals; live model checks consume provider usage.

## Try the UI

```sh
./go.ts --sandbox review
bun tools/ui_driver.ts run current -e 'key ctrl+b c; snap'
```

The sandbox supplies a seeded repository and fake agents with separate HOME,
provider configuration and state. Add a world in [tools/sandboxes/](tools/sandboxes/)
when a feature needs repeatable setup. Sandbox `--restart` discards that world.

The [UI driver](tools/ui_driver.ts) drives a real viewer in an isolated PTY
and records screens. It uses `dist/corgi`, so rebuild first. Scripts live in
[tools/ui_scenarios/](tools/ui_scenarios/) and use the `.scenario` extension.
The command reference is at the top of the driver. Use
[UI tokens and rules](docs/ui_styleguide.md) for visual work.

## Reload, restart and recovery

| Action | What survives |
| --- | --- |
| `./go.ts --env dev --reload` | Rebuilds and hands off the daemon; pane processes and attached viewers stay alive. |
| `corgi reload /absolute/path/to/corgi` | Same handoff using an existing executable. |
| `./go.ts --env dev --restart` | Ends processes, then restores saved context in new shells or dormant agents. Run outside Corgi. |
| `corgi checkpoint` | Saves recovery state now and prints its path. |

Before live handoff commits, the replacement must restore and validate its state.
Failure resumes the old daemon; it never falls back to killing the session.
The transfer retains PTYs, native pipes, viewer sockets and buffered protocol
state. Terminal restoration requests a repaint; parser fragments and some
terminal state are approximate, so applications can retain display artifacts.

Cold recovery restores layout, directories, retained output and agent identities,
not process memory. Ordinary panes start new shells. Recovered agents are dormant
until their pane gains focus, which runs their resume command. Arbitrary saved
input is not replayed. Missing directories fall back to HOME.

Recovery files are private, atomic snapshots under
`${XDG_STATE_HOME:-$HOME/.local/state}/corgi/recovery`, keyed by socket. Malformed
or unsupported files fail startup rather than being replaced with an empty
session. Do recovery experiments in a disposable runtime.

## Change protocols or saved formats

These are separate compatibility boundaries:

| Boundary | Definition |
| --- | --- |
| Management, runtime and viewer wire formats | [protocol.ts](src/protocol.ts), [viewer_version.ts](src/viewer_version.ts) |
| Checkpoint and live handoff JSON | [persist/migrations.ts](src/persist/migrations.ts), [persist/steps.ts](src/persist/steps.ts) |
| Live terminal/update compatibility | `terminal_abi` and `update_abi` in [persist/handoff.ts](src/persist/handoff.ts) |

Wire renames, required-field or type changes require the corresponding protocol
version to change. Defaulted fields can be compatible, but `session.command`
rejects unknown nested fields: changing its payload also affects old clients.
Unversioned requests cannot rely on a version handshake for compatibility.

`hello` and `server.reload` use management protocol 1, checked independently of
the runtime version. Keep their request and reply shapes compatible so a new
client can discover and replace an older daemon. No protocol fallback is needed.
`hello` advertises the client's runtime version in `runtime_protocol`; its reply's
`protocol` advertises the server's runtime version. Only a matching runtime
version negotiates ordinary requests on that connection. Management requests
always carry their own version, even on a negotiated connection.

For saved data, a defaulted addition needs an updated schema snapshot; a rename,
removal or change of meaning needs a migration:

1. Append a pure JSON step to the appropriate list in `persist/steps.ts`.
   Its position defines the version. Never edit a released step or import
   changing runtime types into it.
2. Preserve old fixtures and add input/output examples under
   [src/fixtures/steps/](src/fixtures/steps/). Cover the upgrade, current round
   trip, malformed data and rejection of future versions in persistence tests.
3. Update the relevant `.schema` under [src/fixtures/](src/fixtures/) and review
   its conformance assertions in [core_schema.test.ts](src/core_schema.test.ts).
   These tests include pinned schema hashes; there is no current automatic
   `CORGI_UPDATE_SCHEMA` regeneration command.
4. For live changes, verify process/client continuity and rollback with the
   isolated `reloads` integration suite. State migrations cannot repair an
   incompatible terminal ABI or inherited process interface.

Terminal ABI changes describe whether old terminal snapshots can be restored;
they are independent of JSON schema versions. Update compatibility also gates
live replacement. Check both when changing the native boundary.

Recovery migration writes a backup of the original bytes only after restoration
succeeds, then rewrites the snapshot. Failed decoding or restoration leaves the
source untouched. Migrations run forward only.

## Debug

`server.log` lives beside the runtime socket, normally
`/tmp/corgi-UID/server.log`; `CORGI_SOCKET` selects another runtime. Only the
daemon and handoff process log there. Use `getLogger("scope")` from `src/log.ts`
and `log.warn("Message", { err, ...fields })` for diagnostics. The logger adds
the time and scope; polling jobs keep their own `Failure` to suppress repeats.
`CORGI_LOG_LEVEL` selects `debug`, `info` (the default), `warn` or `error` when
the daemon starts. Activity-summary records include exact
model inputs and outputs, so inspect and redact before sharing logs.

Use `corgi integration status` for hook installation/trust and `corgi which codex`
or `corgi which claude` for executable discovery. `corgi rpc` can inspect a
snapshot; [protocol.ts](src/protocol.ts) defines the requests. Test failures
retain their isolated runtime directory when cleanup fails.

Release builds configured with Sentry report daemon/viewer crashes; ordinary
development builds have no DSN. [crash.ts](src/crash.ts) owns local reports and
uploading; [releases.md](docs/releases.md) covers publisher setup.
