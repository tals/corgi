# Corgi

A multiplexer terminal agent manager, heavily inspired by [herdr](https://github.com/herdrdev/herdr), powered by [Ghostty](https://github.com/ghostty-org/ghostty).

## Install

macOS (Apple Silicon) or Linux (amd64 or arm64):

```sh
curl -fsSL https://corgi.computer/install.sh | bash
```

## First session

1. Run `corgi` in your project directory and choose a shortcut preset.
2. Click **New** in the agent list to start Claude Code, Codex, Pi or OpenCode.
3. Click an agent or pane to focus it; open the shortcut menu with your prefix,
   then `?` (the default prefix is Ctrl+B).
4. Choose **Detach** in the shortcut menu to leave processes running.
5. Run `corgi` again to reconnect.

See the [documentation](docs/reference.md) for setup, workspaces and troubleshooting.

## Uninstall

```sh
curl -fsSL https://corgi.computer/install.sh | bash -s uninstall
```

## Agents

Run `claude`, `codex`, `pi` or `opencode` in any pane. Corgi notices them and
adds its hooks to their settings; Pi gets an extension, and OpenCode needs
nothing. Codex asks you to trust the hooks once, in `/hooks`.

|                                      | Claude Code | Codex | Pi  | OpenCode |
| ------------------------------------ | :---------: | :---: | :-: | :------: |
| Status: ▶ working ● needs you ● done |      ✓      |   ✓   |  ✓  |    ✓     |
| Activity summaries                   |      ✓      |   ✓   |  ✓  |    ✓     |
| Subagents                            |      ✓      |   ✓   |     |    ✓     |
| Context, tokens and rate limits      |      ✓      |   ✓   |  ✓  |    ✓     |
| Rename and fork                      |      ✓      |   ✓   |  ✓  |    ✓     |
| Resume after a crash or reboot       |      ✓      |   ✓   |  ✓  |    ✓     |
| Multi accounts                       |      ✓      |   ✓   |  ✓  |          |


## Scripting

`corgi` controls the running session from any shell. Commands print text
(`--json` for JSON), take IDs from `corgi list`, and accept `current` for the
pane they run in.

```sh
corgi list
corgi tab new --workspace 1 --command 'bun run dev'
corgi pane split current --right --command codex
corgi pane send 3 'run the tests' --enter
corgi pane read 3 --lines 50
```

`corgi --help` lists every command. Agents in a pane can run `corgi --skill` to
learn the interface.

## Development

Needs [Bun](https://bun.sh) and the [pinned Zig toolchain](AGENTS.md#zig-toolchain).

```sh
./go.ts
```

`go.ts` builds and attaches, reloading changed builds while preserving panes.
See [HACKING.md](HACKING.md) for the development workflow and architecture.

## Acknowledgements

- [Ghostty](https://ghostty.org) and [Kitty](https://sw.kovidgoyal.net/kitty/):
  for their pioneering work on computer terminals, and for providing such a
  strong foundation.
- [herdr](https://github.com/herdrdev/herdr): Corgi's main inspiration. We
  borrow many of their ideas.
- [Pi](https://github.com/earendil-works/pi): we use its
  [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui) library.
- [Bun](https://bun.sh): enabled Corgi to be written in TypeScript.

Special thanks to our early testers for their wonderful suggestions and
feedback: [Max Bittker](https://x.com/MaxBittker),
[Aaron Blakeman](https://github.com/ablakeman),
[Kai Johnson](https://github.com/sirkaiserkai),
[Luke Alonso](https://github.com/lukealonso) and
[Keith Adams](https://pebblebed.com/team/keith-adams).

## License

Corgi is released under the [MIT License](LICENSE).

The notification sounds in [`assets/sounds/`](assets/sounds/) come unchanged
from herdr and stay under herdr's
[Apache License 2.0](assets/sounds/LICENSE); see
[their README](assets/sounds/README.md).

`corgi licenses` prints these together with the licenses of the other
software Corgi includes, listed in [`assets/licenses.txt`](assets/licenses.txt).
