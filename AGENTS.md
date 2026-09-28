# Agent notes

## Commands

- **Build:** `./scripts/zig build`
- **Unit tests:** `./scripts/zig build test`
  - While iterating, run a subset with `-Dtest-filter=<substring>` (repeat
    the flag for several). Run the full suite before finishing.
- **Formatting:** `./scripts/zig fmt src`
- **Other build configs to keep compiling:** `-Dviewer-test-driver=true`,
  `-Dtest-build=true -Dupdate-test-mode=true`
- **Integration tests:** see `tests/README.md`. Parallel runs are flaky under
  load; rerun a failing suite with `--jobs 1` before investigating.

## Zig toolchain

Build and test through `./scripts/zig`, never bare `zig`:

```sh
./scripts/zig build
./scripts/zig build test
```

Corgi requires exactly Zig 0.15.2. Zig breaks its APIs between minor releases,
and the pinned Ghostty commit targets 0.15.2. A newer `zig` may be first on
PATH (such as Homebrew's 0.16.0); running it fails with `Your Zig version v0.16.0
does not meet the required build version of v0.15.2` or `no field or member
function named 'linkLibC'`. `scripts/zig` uses `$ZIG`, a 0.15.2 `zig` on PATH,
or the project copy in `.tools/zig-aarch64-macos-0.15.2/`, and refuses any other
version.

## Zig style

Write Zig the way Ghostty does. When unsure, read how Ghostty's source solves
the same problem (a checkout may be at `~/dev/rand/cmux/ghostty/src`; for
example `Surface.zig`, `input/Binding.zig`, `cli/action.zig`).

**Imports.** One block at the top of the file; never `@import("x.zig").Thing`
inside fields, signatures or bodies. Alias a module by its file name
(`const launch_command = @import("launch_command.zig");`), or alias the type
(`const Actor = @import("conversations.zig").Actor;`). Rename an alias only
when a local, parameter or declaration (such as a method) would clash with it
(Zig reports shadowing or "ambiguous reference"); struct fields never do. Don't
bulk-replace `@import("x.zig").` with sed: it also rewrites the alias line into
`const x = x;`.

**Strings are parsed once, at the boundary.**
- A closed set of names (ops, commands, actions, provider event types) is an
  enum: `std.meta.stringToEnum(E, s)`, then `switch`. Tags can carry dots and
  slashes (`@"session.list"`, `@"item/completed"`); `@tagName` is the wire
  string, so the protocol doesn't change.
- Unknown input is `null`: `stringToEnum(...) orelse return error.X`. Don't
  add `invalid`/`unknown` tags.
- Many spellings for one meaning use a comptime `std.StaticStringMap`, like
  `keys.zig` for escape sequences.
- A single check stays inline: `std.mem.eql(u8, x, "chatgpt")`. No
  one-value enums, and no local `fn eq` helpers.
- Each vocabulary has one home: `protocol.Op`, `keys.Key`,
  `providers/codex.zig` (`Method`, `ItemType`), `providers/claude.zig`
  (`MessageType`, `BlockType`), `providers/common.zig` (`HookEvent`),
  `transcript.zig` (`RolloutKind`, `EventKind`, `ClaudeLine`). Extend these
  rather than redefining a local copy.

**Never read display text back as state.** Keep an enum or bool and derive the
label from it (`Semantics.yolo`, not `mode.text() == "Skips permission
checks"`). Compare error names with `@errorName(error.X)`, not typed copies.

**IDs are typed.** Each kind of ID is its own hand-written
`enum(u32) { _, pub const none ... }` (`Actor.Id`, `layout.PaneId`,
`Workspace.Id`, ...). `none` is a declaration, not a tag, so JSON keeps plain
numbers; compare with `PaneId.none` (`.none` only works where the type is
known). Declare an ID inside the type it identifies (`Workspace.Id`), or as
`FooId` in a module named for something else (`layout.PaneId`); never
`workspace.WorkspaceId`. Unlike Ghostty's local integer IDs, these cross most
modules, so other files alias a nested one as `FooId`
(`const WorkspaceId = @import("workspace.zig").Workspace.Id;`), an exception
to the import alias rule.

**Logging.**
- Daemon modules use `const log = std.log.scoped(.module);`, and write
  `catch |err| log.warn("what failed: {}", .{err})`. Format errors with `{}`.
- Viewer code (controller, render, sidebar, client, dialogs) never logs: its
  stderr is the user's terminal. Neither does `corgi hook`, whose stderr the
  provider may capture.
- Best-effort cleanup stays `catch {}`: temp files, bells, `timedWait`,
  writes to a client that may be gone.
- Anything in a periodic loop warns once per distinct failure, not every
  cycle (see `same` in `ports.zig`).

**Types.** Prefer concrete types (`*Server`, `*Client`) to `anytype`; circular
imports are fine in Zig. Keep `anytype` for real generics or test fakes.
Avoid `anyerror` returns.

**Lines and comments.** Lines over about 200 characters are usually
`if … else if …` chains; make them a `switch` or a small named helper. Data
tables and prompt text may stay long. Keep comments terse, like the code
around them, and don't narrate the refactor that produced the code.

**Saved formats.** Anything serialized into a checkpoint or handoff is checked
by the schema snapshots in `src/fixtures/`. A new field with a default only
needs a refreshed snapshot. A rename, removal or change of meaning needs a
migration step; see `docs/development-reloads.md`.

## Commit messages

Keep them short enough to read in `git log`: a subject and usually three to
six body lines.

**Subject.** `area: summary`, lowercase after the colon, no period. The area is
a subsystem, such as `protocol`, `viewer`, `daemon`, `sidebar`, `launcher`,
`claude`, `codex`, `inference`, `resources`, `saved-state`, `tests`, `build`
or `docs`. A change that spans several takes the one it affects most, never
`refactor`. Write the summary as an imperative, like Ghostty's subjects:

```
viewer: size shared panes for the last-used viewer
build: add -Dtest-filter to run a subset of unit tests
```

**Body.** How it was, what was wrong with that, how it is now. Name the
component ("The daemon used to send…"), not "we". Give one concrete string or
number. Leave out how it works; the diff shows that. Name only identifiers
someone will type: flags, ops, env vars.

**Compatibility.** When something crosses a boundary (the wire protocol, the
viewer protocol, checkpoints, handoffs or preferences), a second paragraph says
exactly which version changed and whether there is a migration, or that none
changed and why. Say "unchanged" only where a reader would wonder, such as a
refactor of serialized types.

**One change per commit.** Split unrelated changes when you can; otherwise the
second one gets an "Also:" line.

```
protocol: send usage limits as data, not text

The daemon used to send usage as "5h 12% / 7d 48%", and the launcher
parsed that back into state. Now it sends the structured limits.

The protocol version stays 1: the field was renamed, so a viewer and
daemon on different versions show no usage instead of failing.
Handoff version 2 -> 3, with a migration.
```
