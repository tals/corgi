# Agent notes

See [HACKING.md](HACKING.md) for development workflows and architecture.

## Commands

- **Build:** `bun build.ts` (`--no-native` skips the Zig native layer when
  only TypeScript changed). The binary is `dist/corgi`.
- **Unit tests:** `bun test src`
  - While iterating, pass a file or `-t <name>`. Run the full suite before
    finishing.
- **Typecheck:** `bun typecheck.ts`. It also fails on unformatted code.
- **Format:** `bun format.ts` runs the pinned Prettier (Bun's own settings,
  `.prettierrc`) over the TypeScript; `--check` only lists files.
- **Integration tests:** `bun build.ts --test`, then
  `bun integration.ts` (or name suites). See `tests/README.md`.
  Parallel runs are flaky under load; rerun a failing suite with `--jobs 1`
  before investigating.
- **Run it:** `./go.ts` (`--temp`, `--env NAME`, `--reload`; see README).
- **Try a feature by hand:** `./go.ts --sandbox NAME` opens a seeded world
  with fake agents, apart from your own Corgi (`tools/sandboxes/`). Add one
  when a feature needs a particular world to poke at.
- **UI driver:** `bun tools/ui_driver.ts run current -e 'key ctrl+b c; snap'` drives a
  viewer in a PTY and records its screens. See `tools/ui_driver.ts`.
- **Screenshots:** `bun tools/ghostty_screenshot.ts --sandbox NAME -o shot.png`
  captures a live Ghostty window on Xvfb. Use this for documentation and UI
  screenshots so fonts, box drawing and Kitty images retain terminal fidelity.
  Do not repaint terminal cells into SVG, canvas or another terminal renderer.
  `serve` keeps one running for an agent to drive over its socket and capture
  on demand; see HACKING.md.
- **Landing page:** `bun run landingpage:dev` serves `site/` and reloads on
  save; `landingpage:build` writes one self-contained `site/dist/index.html`
  (and `moonlander.html`), `landingpage:start` serves it, and
  `landingpage:publish` builds it and deploys it to corgi.computer with
  wrangler, as an assets-only Worker routed on `/` and `/moonlander`
  (`site/wrangler.jsonc`); other paths go straight to the release bucket.
  Keep it script-free and narrowly routed: asset hits are free, but a
  script runs on every request it sees and counts against the plan's
  limit. `bun tools/site_frames.ts`
  re-records the page's screens into `site/frames.json` with Corgi's renderer
  (`--check` compares). The page imports Corgi's animation code, so keep
  `src/corgi_animation.ts` browser-safe. It also runs the review panel, the
  resource card, the command menu and the worktree overview, with
  `site/browser/` standing in for git, files, the resource sampler, ports,
  launch commands, zlib, the native widths (package.json's `"browser"`
  field), `process.platform` and `Buffer`; a new Node or native import under
  `src/review/`, `src/resource_tooltip.ts`, `src/shortcut_help.ts`,
  `src/worktree_tooltip.ts` or what it imports (the sidebar among them)
  needs a stand-in there too.
  The hero's first frame is prerendered from `site/main.js` on builds and
  dev saves; `site/.generated/` is disposable. Keep its mobile breakpoint
  and column count in `site/hero_config.ts`.
  Wrangler's local `dev` server is incompatible with Bun (its runtime
  dispatcher fails on reload); run that diagnostic with Node. The site
  build and publish commands use Bun.

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

The native layer requires exactly Zig 0.17.0; the pinned Ghostty release
targets it. Build through `./scripts/zig` (or let `bun build.ts` do it),
never bare `zig`. `scripts/zig` uses `$ZIG`, a 0.17.0 `zig` on PATH, the
project copy in `.tools/zig-<arch>-<os>-0.17.0/`, or in a linked worktree the
main checkout's copy, downloading it into the project when none is found, and
refuses other versions. A Zig bump changes its version and checksums.

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
  `providers/codex/`, `providers/claude/`, `providers/common.ts`. Extend
  these rather than redefining a local copy.

**Never read display text back as state.** Keep a union or boolean and
derive the label from it. Compare errors by name with `errors.ts`
(`errors.is(error, "Timeout")`, or `switch (errors.name(error))`), not by
display text.

**Wire values are normalized once.** JSON from the daemon or a provider goes
through one function that fills defaults and types (`mirror.agent()`,
`subagent_tooltip.conversation()`); code past it doesn't use `any`.

**Numbers.** 64-bit counters and IDs that can exceed 2^53 are `bigint`.
Byte lengths where the protocol counts bytes use `text.byteLength`; screen
widths use `text.displayWidth`, which follows Ghostty's codepoint widths.

**Logging.** Only `serve` and `__handoff` log (their stderr is server.log).
`corgi voice --verbose` also logs, to its own `voice.log`: its stderr is its screen.
A periodic job warns once per distinct failure, not every cycle.
Best-effort cleanup may swallow errors.

**UI colors.** Take them from `palette.ts` tokens, never RGB literals.
`docs/ui_styleguide.md` says which token means what.

**Lines and comments.** Prettier sets the layout. Keep lines readable; long
`if … else if …` chains become a `switch` or a small named helper. Keep
comments terse, like the code around them, and don't narrate the refactor
that produced the code.

**Saved formats.** Anything serialized into a checkpoint or handoff is
checked by the schema snapshots in `src/fixtures/`. A new field
with a default only needs a refreshed snapshot. A rename, removal or change
of meaning needs a migration step; see [HACKING.md](HACKING.md#change-protocols-or-saved-formats).

## Zig style (native/)

Write Zig the way Ghostty does. Keep the native boundary small: plain
functions over FFI, JSON or fixed-size buffers across it, and no policy that
belongs in TypeScript.

## Commit and PR messages

Write for someone deciding what changed and why they care. The message's
length follows the idea, not the size of the diff. A large redesign may need
only three capability bullets; a subtle fix may need a concrete example.

**Subject.** `area: summary`, start with a lowercase verb, no period. Preserve
names and acronyms such as Ghostty and CLI. The area is a subsystem, such as
`protocol`, `viewer`, `daemon`, `sidebar`, `launcher`,
`claude`, `codex`, `inference`, `resources`, `saved-state`, `native`, `tests`,
`build` or `docs`. A change that spans several takes the one it affects most,
never `refactor`. Write the summary as an imperative:

```
viewer: size shared panes for the last-used viewer
build: skip the native layer with --no-native
```

Name the overall change, not a selection of its details. For polish, say
which part is being polished; leave the individual adjustments to the body:

```
site: touchup to review section
```

not

```
site: review moonlander's thrusters with the rest dimmed
```

**Choose the shape.** A short paragraph is usually enough. Use a few short
bullets for independent capabilities or visible changes. Use before/after
paragraphs when the old behavior explains the fix. These are options, not a
template: don't manufacture an "it couldn't do X" preamble for every feature,
repeat the subject in the body, or add headings to a small change.

**Choose what earns space.**

- Lead with the behavior, capability or reason for the change. For a bug,
  give the trigger and symptom; one recognizable example often explains more
  than the internal failure chain. Keep the reason a behavior was wrong:
  a workspace root chosen by the user should not move when tabs are reordered.
- Write at the level of the change. A UI redesign needs its main capabilities;
  stop before expanding each into controls, defaults and supporting fixes.
  A new authoring model or native boundary may need its mechanism. Keep the
  detail that explains how contributors use or extend it, or why a surprising
  choice was necessary. Keep what establishes a capability, such as where a
  new platform is built and tested; the diff can carry the rest.
- Keep a shortcut, command, language list, visible label or limit when it makes
  the main change concrete. These are candidates, not a checklist. For a tool,
  give the shortest complete workflow for what you advertise, or link to it.
  A compact walkthrough can earn its space; secondary options and per-viewer
  bookkeeping usually belong in docs.
- Cut whole secondary facts before shortening sentences. Packing every detail
  into fewer words still produces a changelog. Supporting fixes, defensive
  cases, caches and cleanup usually belong under the main idea, not in the
  message as extra accomplishments.
- Use ordinary words and concrete subjects. Say "gray", not a palette token,
  unless the token itself matters. Skip file/function inventories, test totals,
  implementation counts, stock assurances and a closing sentence that restates
  the benefit. Don't invent motivation, results or a personal anecdote.

**Compatibility.** Include actual version changes, required migrations and
material effects on older clients or saved state. Name the affected boundary
and what happens, briefly. An additive field can matter; list it when a reader
needs to understand its default or how older code handles it. Don't append a
roll call of unchanged wire, viewer, checkpoint and handoff versions just
because the code touches them. Explain an unchanged version only when the
change would otherwise leave a real compatibility question.

**PRs.** Use the same title and core description as the intended commit. Add
only what helps review or try the change: a screenshot, runnable example,
material limitation or concise verification. Usually a `Tested: ...` line is
enough; include failures or checks not run when they affect confidence. Don't
add Summary / Changes / Validation / Compatibility sections by habit, or a
list of every test and edge case. Larger explanations can link to docs or a
report. State results for the current change, not an earlier revision.

**Before sending.** Read the message without the diff. Can a reader identify
the main change and its reason or use? Does each remaining detail change that
understanding or help them use or review it? Remove the rest. If scope changed,
rewrite the description around the final result; don't narrate abandoned
approaches, review rounds or the work session. For a squash, write one message
for the whole change rather than concatenate the branch's commit messages.

**One logical change per commit.** A fix or feature is one commit even when it
touches several components; don't split it by component. Split unrelated
changes when you can; otherwise the second one gets an "Also:" line.
