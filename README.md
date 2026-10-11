# Corgi

A multiplexer terminal agent manager, heavily inspired by [herdr](https://github.com/herdrdev/herdr), powered by [Ghostty](https://github.com/ghostty-org/ghostty).

## Install

macOS (Apple Silicon) or Linux (amd64):

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

## Uninstall

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## Agents

Run `claude` or `codex` in any pane. Corgi notices them and adds its hooks to
their settings. Codex asks you to trust the hooks once, in `/hooks`.

|                                      | Claude Code | Codex |
| ------------------------------------ | :---------: | :---: |
| Status: ▶ working ● needs you ● done |      ✓      |   ✓   |
| Activity summaries                   |      ✓      |   ✓   |
| Subagents                            |      ✓      |   ✓   |
| Context, tokens and rate limits      |      ✓      |   ✓   |
| Rename and fork                      |      ✓      |   ✓   |
| Resume after a crash or reboot       |      ✓      |   ✓   |

## Scripting

`corgi` controls the running session from any shell. Commands print JSON
(`--text` for readable output), take IDs from `corgi list`, and accept `current`
for the pane they run in.

```sh
corgi list --text
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --lines 50 --text
```

`corgi --help` lists every command. Agents in a pane can run `corgi --skill` to
learn the interface.

## Development

Needs [Bun](https://bun.sh) and [Zig](https://ziglang.org) 0.16.0 (on PATH, or
set `ZIG`).

```sh
./go.ts
```

`go.ts` builds Corgi, then starts its runtime or attaches to the running one.
When the build changed, it live-reloads the runtime; running panes survive. Run
from inside a Corgi pane, it reattaches that viewer to the new build.
`./go.ts --help` lists the options.

## Acknowledgements

- [Ghostty](https://ghostty.org) and [Kitty](https://sw.kovidgoyal.net/kitty/):
  for their pioneering work on computer terminals, and for providing such a
  strong foundation.
- [herdr](https://github.com/herdrdev/herdr): Corgi's main inspiration. We
  borrows many of their ideas.
- [Pi](https://github.com/earendil-works/pi): we uses its 
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) library.
- [Bun](https://bun.sh): enabled Corgi to be written in TypeScript.

Special thanks to our early testers for their wonderful suggestions and
feedback: [Max Bittker](https://x.com/MaxBittker),
[Aaron Blakeman](https://github.com/ablakeman),
[Kai Johnson](https://github.com/sirkaiserkai) and
[Luke Alonso](https://github.com/lukealonso).
