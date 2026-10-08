# Agent notes

## Commands

- **Build:** `bun build.ts` (`--no-native` skips the Zig native layer when
  only TypeScript changed). The binary is `dist/corgi`.
- **Unit tests:** `bun test src`
  - While iterating, pass a file or `-t <name>`. Run the full suite before
    finishing.
- **Typecheck:** `bun typecheck.ts`
- **Integration tests:** `bun build.ts --test`, then
  `bun integration.ts --jobs 1` (or name suites). See `tests/README.md`.
  Parallel runs are flaky under load; rerun a failing suite with `--jobs 1`
  before investigating.
- **Run it:** `./go.ts` (`--temp`, `--env NAME`, `--reload`; see README).
- **UI probe:** `bun tools/probe.ts run bun -e 'key ctrl+b c; snap'` drives a
  viewer in a PTY and records its screens. See `tools/probe.ts`.

## Layout

- `src/`: the application, in TypeScript on Bun: daemon, viewer and CLI.
- `native/`: the native layer Bun loads over FFI (terminal emulation, frame
  diffs, keyboard encoding, PTYs, process checks, crash reports) and the
  `corgi-hook` sender. `native/build.zig` builds it.
- `native/zig/`: the Zig sources the native layer compiles, kept from
  Corgi's Zig era. Change them only for the native layer's sake.
- `tests/`: integration suites, run against `dist/corgi-test`.
- `evals/`: live activity-summary evals (`bun test evals` has no model calls;
  `bun run evals/run.ts` calls the real models). See `evals/README.md`.
- `assets/`: help text, sounds and other files built into the binary.
- `scripts/zig`: the pinned Zig toolchain.

## Zig toolchain

The native layer requires exactly Zig 0.16.0; the pinned Ghostty commit
targets it. Build through `./scripts/zig` (or let `bun build.ts` do it),
never bare `zig`. `scripts/zig` uses `$ZIG`, a 0.16.0 `zig` on PATH, or the
project copy in `.tools/zig-<arch>-<os>-0.16.0/`, and refuses other versions.

## TypeScript style

Modules keep the shapes they had in Zig: one file per concern, the same
names, and tests beside the code (`foo.ts`, `foo.test.ts`).

**Imports.** One block at the top of the file. Import a module as a
namespace named for its file (`import * as layout from "./layout"`) or name
the types you use. Use `import type` for types only.

**Strings are parsed once, at the boundary.**
- A closed set of names (ops, commands, actions, provider event types) is a
  string union. Parse unknown input to the union or `null`, then `switch`.
  Don't add `invalid`/`unknown` members.
- Many spellings for one meaning use one lookup table.
- Every viewer command is an `action.Action`, whether a key, a click,
  `corgi action` or a daemon control asks for it.
- Each vocabulary has one home: `protocol.ts`, `keys.ts`,
  `providers/codex.ts`, `providers/claude.ts`, `providers/common.ts`. Extend
  these rather than redefining a local copy.

**Never read display text back as state.** Keep a union or boolean and
derive the label from it. Compare errors by name (`error.message ===
"Timeout"`), not by display text.

**Wire values are normalized once.** JSON from the daemon or a provider goes
through one function that fills defaults and types (`mirror.agent()`,
`subagent_tooltip.conversation()`); code past it doesn't use `any`.

**Numbers.** 64-bit counters and IDs that can exceed 2^53 are `bigint`.
Byte lengths where the protocol counts bytes use `text.byteLength`; screen
widths use `text.displayWidth`, which follows Ghostty's codepoint widths.

**Logging.** Only `serve` and `__handoff` log (their stderr is server.log).
A periodic job warns once per distinct failure, not every cycle.
Best-effort cleanup may swallow errors.

**UI colors.** Take them from `palette.ts` tokens, never RGB literals.
`docs/ui_styleguide.md` says which token means what.

**Lines and comments.** Keep lines readable; long `if … else if …` chains
become a `switch` or a small named helper. Keep comments terse, like the
code around them, and don't narrate the refactor that produced the code.

**Saved formats.** Anything serialized into a checkpoint or handoff is
checked by the schema snapshots in `src/fixtures/`. A new field
with a default only needs a refreshed snapshot. A rename, removal or change
of meaning needs a migration step; see `docs/development-reloads.md`.

## Zig style (native/)

Write Zig the way Ghostty does. Keep the native boundary small: plain
functions over FFI, JSON or fixed-size buffers across it, and no policy that
belongs in TypeScript.

## Commit messages

Write for someone skimming `git log`: a subject, then a few short paragraphs
of plain sentences.

**Subject.** `area: summary`, lowercase after the colon, no period. The area is
a subsystem, such as `protocol`, `viewer`, `daemon`, `sidebar`, `launcher`,
`claude`, `codex`, `inference`, `resources`, `saved-state`, `native`, `tests`,
`build` or `docs`. A change that spans several takes the one it affects most,
never `refactor`. Write the summary as an imperative:

```
viewer: size shared panes for the last-used viewer
build: skip the native layer with --no-native
```

**Body.** Say how it was and what was wrong with that. Then start a new
paragraph with how it is now, and stop there. Name the component ("The
daemon used to send…"), not "we". Keep each paragraph to a few short lines;
when one runs long, cut detail rather than packing it tighter.

Keep only what a reader needs to follow the change. Leave out:
- how the old or the new code works; the diff shows that
- counts and sizes: files, call sites, tests, casts, bytes
- lists of the files or functions touched
- identifiers nobody will type (keep flags, ops, env vars)
- the problem restated as a benefit
- the same point said twice

When it makes the change concrete, quote one thing the user saw, such as the
text "5h 12% / 7d 48%".

**Compatibility.** When something crosses a boundary (the wire protocol, the
viewer protocol, checkpoints, handoffs or preferences), a final paragraph says
exactly which version changed and whether there is a migration, or that none
changed and why. Say "unchanged" only where a reader would wonder.

**One logical change per commit.** A fix or feature is one commit even when it
touches several components; don't split it by component. Split unrelated
changes when you can; otherwise the second one gets an "Also:" line.
