# Integration tests

The test harness and provider fixtures run on Bun. Corgi itself remains Zig;
the optional audio-authoring utilities in `docs/sound-audition/` remain Python.
No integration test or generated provider program requires Python.

Build the test-enabled binary, then run the suites:

```sh
./scripts/zig build test -Dcodesign=false
test_prefix=$(mktemp -d /tmp/corgi-tests.XXXXXX)
./scripts/zig build -Dcodesign=false -Doptimize=ReleaseSafe -Dviewer-test-driver=true --prefix "$test_prefix"
export CORGI_TEST_BIN="$test_prefix/bin/corgi"
bun run tests/run.ts
```

The runner starts a separate Bun process for each suite and runs several at
once (`--jobs N`, default half the cores up to 6; `--jobs 1` runs them one by
one with live output). Parallel suites print their output when they finish.
Durations from the previous run, kept in `.zig-cache/test-timings.json`, start
the slowest suites first. It prints a pass/fail table and exits nonzero when
any suite fails.

Cases within a suite run one at a time unless the suite registers with
`registerCase(..., { concurrent: true })`. Only mark suites whose cases share
nothing beyond their own runtime and do not depend on tight timing. Each runtime
uses a temporary home, provider settings, and socket; mock providers make no
model requests. A test failure is not converted into a skip if Unix sockets or
PTYs are unavailable in the execution environment.

```sh
bun run tests/run.ts --list
bun run tests/run.ts smoke smoke_input smoke_terminal viewers reloads
bun run tests/run.ts activity_summary -- --test-name-pattern abstention
CORGI_TEST_BIN=/path/to/corgi bun test tests/cli.test.ts
bun run tests/run.ts --check --external --dev
```

`--check` parses and bundles the suites without executing them; it is not a
replacement for running the tests. The former smoke suite is split into
`smoke`, `smoke_input`, and `smoke_terminal`. Scenarios retain their original
names where the behavior is unchanged; UI checks follow the current shortcut
help and new-tab agent picker.

Developer-launch tests invoke `go.sh` and are opt-in (`bun run tests/run.ts dev`).
They expect the fixture binary to match the developer build. The alternate-build
reload case additionally needs `CORGI_OLD_EXE`. On macOS the fixture discovers
the host signing identity before isolating `HOME`; the developer build must
already be available in the compiler cache.
Live Herdr handoff is also opt-in:

```sh
./scripts/zig build test-handoff -Dcodesign=false -Dherdr-bin=/path/to/herdr
# Or, using binaries already built:
bun run tests/run.ts herdr_handoff --corgi /path/to/corgi --herdr /path/to/herdr
```

`support.ts` owns process deadlines, buffered line readers, raw JSON sockets,
and PTYs. `viewer_client.ts` drives the actual viewer protocol. `runtime.ts`
owns isolated daemon setup and cleanup. Provider fixtures live in
`provider_sim.ts` and `inference_harness.ts`. Shared fixture modules do not
register tests when imported; `.test.ts` entry points register their scenarios
with Bun's test runner. The small assertion adapter preserves scenario names
and assertion intent from the original suites.

PTY restoration checks compare `stty -g` snapshots on the same reusable
terminal before and after the client, including control characters and speeds.
