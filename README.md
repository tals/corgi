# Corgi <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-dark.svg"><img src="https://raw.githubusercontent.com/tals/corgi/3a9d723dc864fc924d23c960d920c449313c3716/corgi-light.svg" alt="Corgi's corgi, wagging its tail"></picture>

A terminal multiplexer for running coding agents side by side. Powered by
[Ghostty](https://github.com/ghostty-org/ghostty), inspired by
[herdr](https://github.com/herdrdev/herdr).

[![Corgi with Claude Code and Codex running side by side](https://corgi.computer/images/hero.gif)](https://corgi.computer)

## Install

macOS (Apple Silicon) or Linux (amd64 or arm64):

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

Run `corgi` in your project directory, choose a shortcut preset, and click
**New** to start an agent.

Press your prefix (Ctrl+B by default), then `?` for shortcuts. Choose
**Detach** in that menu to leave agents running; run `corgi` to reconnect.

See the [documentation](docs/reference.md) for setup, workspaces and troubleshooting.

Corgi and its installer support English, 简体中文, 日本語, 한국어 and русский.
Change the language in **Corgi setup → Language**.

## Agents

Run `claude`, `codex`, `pi`, `opencode` or `omp` in any pane. Corgi detects
them automatically and installs hooks for Claude Code and Codex, or an
extension for Pi and Oh My Pi. OpenCode needs no setup. Codex asks you to
trust the hooks once, in `/hooks`.

|                                      | Claude Code | Codex | Pi  | OpenCode | Oh My Pi |
| ------------------------------------ | :---------: | :---: | :-: | :------: | :------: |
| Status: ▶ working ● needs you ● done |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Activity summaries                   |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Subagents                            |      ✓      |   ✓   |     |    ✓     |    ✓     |
| Context, tokens and rate limits      |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Rename and fork                      |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Resume after a crash or reboot       |      ✓      |   ✓   |  ✓  |    ✓     |    ✓     |
| Multiple accounts                    |      ✓      |   ✓   |  ✓  |          |          |

## Scripting

Control the running session from any shell. Use `--json` for JSON output,
IDs from `corgi list` to target panes, or `current` for the pane you're in.

```sh
corgi list
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --lines 50
```

`corgi --help` lists the commands; `corgi --skill` prints instructions for agents.

## Uninstall

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## Tricks

[Corgi Tricks](docs/tricks.md) are small programs that watch JSONL events and
add sidebar colors, badges and text overlays. A TOML manifest configures each
trick; an optional persistent KV store keeps its state across restarts.
Try the account-color, provider-flair, attention-radar and completion-jar
examples together with `./go.ts --sandbox tricks`.

## Development

Install [Bun](https://bun.sh), then run:

```sh
./go.ts
```

`go.ts` downloads the [pinned Zig toolchain](AGENTS.md#zig-toolchain), builds
and starts Corgi. Later runs reload changed builds while preserving panes.
See [HACKING.md](HACKING.md) for the development workflow and architecture.

## Acknowledgements

- [Ghostty](https://ghostty.org) and [Kitty](https://sw.kovidgoyal.net/kitty/):
  for their terminal emulation and graphics work.
- [herdr](https://github.com/herdrdev/herdr): Corgi's main inspiration. We
  borrow many of their ideas.
- [Pi](https://github.com/earendil-works/pi): we use its
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) library.
- [Bun](https://bun.sh): Corgi's TypeScript runtime.

Thanks to our early testers for their suggestions and feedback:
[Max Bittker](https://x.com/MaxBittker),
[Aaron Blakeman](https://github.com/ablakeman),
[Kai Johnson](https://github.com/sirkaiserkai),
[Luke Alonso](https://github.com/lukealonso),
[Keith Adams](https://pebblebed.com/team/keith-adams) and
[Roland Huß](https://ro14nd.de).

## License

Corgi is released under the [MIT License](LICENSE).

The notification sounds in [`assets/sounds/`](assets/sounds/) come unchanged
from herdr and stay under herdr's
[Apache License 2.0](assets/sounds/LICENSE); see
[their README](assets/sounds/README.md).

`corgi licenses` prints these together with the licenses of the other
software Corgi includes, listed in [`assets/licenses.txt`](assets/licenses.txt).
