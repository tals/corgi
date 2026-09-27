# Agent notes

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
