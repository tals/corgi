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
- **Unit or Bun test:** decisions are unit tests; see `tests/README.md`.

## Zig toolchain

Build and test through `./scripts/zig`, never bare `zig`:

```sh
./scripts/zig build
./scripts/zig build test
```

Corgi requires exactly Zig 0.16.0. Zig breaks its APIs between minor releases,
and the pinned Ghostty commit targets 0.16.0. Another `zig` may be first on
PATH; running it fails with `Your Zig version vX does not meet the required
build version of v0.16.0`. `scripts/zig` uses `$ZIG`, a 0.16.0 `zig` on PATH,
or the project copy in `.tools/zig-aarch64-macos-0.16.0/`, and refuses any other
version.

## Zig style

Write Zig the way Ghostty does. When unsure, read how Ghostty's source solves
the same problem (a checkout may be at `~/dev/rand/cmux/ghostty/src`; for
example `Surface.zig`, `input/Binding.zig`, `cli/action.zig`).

**Imports.** One block at the top of the file; never `@import("x.zig").Thing`
inside fields, signatures or bodies. Alias a module by its file name
(`const layout = @import("layout.zig");`), or alias the type
(`const Actor = @import("conversations.zig").Actor;`). Rename an alias only
when a local, parameter or declaration (such as a method) would clash with it
(Zig reports shadowing or "ambiguous reference"); struct fields never do. Don't
bulk-replace `@import("x.zig").` with sed: it also rewrites the alias line into
`const x = x;`. A directory under `src/` is a package: other files import the
root beside it (`const handoff = @import("persist.zig").handoff;`), files
inside import each other by name, and the root's `test` block lists every file
in the directory. `providers/` isn't one yet: other files still import
`providers/claude.zig` and its siblings directly.

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
- Every viewer command is an `action.Action`, whether a key, a click,
  `corgi action` or a daemon control asks for it.
- Each vocabulary has one home: `protocol.Op`, `keys.Key`,
  `providers/codex.zig` (`Method`, `ItemType`, `RolloutKind`, `EventKind`),
  `providers/claude.zig` (`MessageType`, `BlockType`, `TranscriptLine`),
  `providers/common.zig` (`HookEvent`). Extend these rather than redefining
  a local copy.

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
- Modules use `const log = std.log.scoped(.module);`, and write
  `catch |err| log.warn("what failed: {}", .{err})`. Format errors with `{}`.
- Only `serve` and `__handoff` turn logging on (`log_sink` in `main.zig`);
  their stderr is server.log. Log calls elsewhere are dropped (unit tests
  still print warnings, and a `log.err` fails the test), so shared modules
  may log, but a warning the viewer or `corgi hook` raises is lost.
- Best-effort cleanup stays `catch {}`: temp files, bells, `timedWait`,
  writes to a client that may be gone.
- Anything in a periodic loop warns once per distinct failure, not every
  cycle: keep a `Failure` (`failure.zig`) per job.

**I/O.** Files, clocks, sleeps, locks and child processes take a `std.Io`:
pass `os.io()`, which is `std.testing.io` in tests. Use `os.milliTimestamp`,
`os.sleep` and `os.Timer` for time, and `compat.timedWait` to wait on a
condition with a timeout.

**UI colors.** Take them from `palette.zig` tokens, never RGB literals.
`docs/ui_styleguide.md` says which token means what.

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

Write for someone skimming `git log`: a subject, then a few short paragraphs
of plain sentences.

**Subject.** `area: summary`, lowercase after the colon, no period. The area is
a subsystem, such as `protocol`, `viewer`, `daemon`, `sidebar`, `launcher`,
`claude`, `codex`, `inference`, `resources`, `saved-state`, `tests`, `build`
or `docs`. A change that spans several takes the one it affects most, never
`refactor`. Write the summary as an imperative, like Ghostty's subjects:

```
viewer: size shared panes for the last-used viewer
build: add -Dtest-filter to run a subset of unit tests
```

**Body.** Say how it was and what was wrong with that. Then start a new
paragraph with how it is now, and stop there. Name the component ("The
daemon used to send…"), not "we". Keep each paragraph to a few short lines;
when one runs long, cut detail rather than packing it tighter.

Keep only what a reader needs to follow the change. Leave out:
- how the old or the new code works; the diff shows that. Say the sidebar
  flickered, not the redraw order that made it flicker
- counts and sizes: files, call sites, tests, casts, bytes
- lists of the files or functions touched
- identifiers nobody will type (keep flags, ops, env vars)
- the problem restated as a benefit ("so the launcher no longer parses it")
- the same point said twice

When it makes the change concrete, quote one thing the user saw, such as the
text "5h 12% / 7d 48%".

**Compatibility.** When something crosses a boundary (the wire protocol, the
viewer protocol, checkpoints, handoffs or preferences), a final paragraph says
exactly which version changed and whether there is a migration, or that none
changed and why. Say "unchanged" only where a reader would wonder, such as a
refactor of serialized types.

**One logical change per commit.** A fix or feature is one commit even when it
touches several components, such as the hook client, the daemon and the docs;
don't split it by component. Split unrelated changes when you can; otherwise
the second one gets an "Also:" line.

```
protocol: send usage limits as data, not text

The daemon used to send usage as "5h 12% / 7d 48%", and the launcher
parsed that back into state.

Now it sends the structured limits.

The protocol version stays 1: the field was renamed, so a viewer and
daemon on different versions show no usage instead of failing.
Handoff version 2 -> 3, with a migration.
```
