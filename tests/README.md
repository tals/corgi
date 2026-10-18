# Integration tests

Corgi, the test harness and the provider fixtures all run on Bun. The
optional audio-authoring utilities in `docs/sound-audition/` remain Python.
No integration test or generated provider program requires Python.

Build the test-enabled binary, then run the suites:

```sh
bun build.ts --test       # dist/corgi-test, the default CORGI_TEST_BIN
bun integration.ts        # or: bun run tests/run.ts
```

The runner starts a separate Bun process for each suite and runs several at
once (`--jobs N`, default half the cores up to 6; `--jobs 1` runs them one by
one with live output). Parallel suites print their output when they finish.
Durations from the previous run, kept in `.zig-cache/test-timings.json`, start
the slowest suites first. It prints a pass/fail table and exits nonzero when
any suite fails.

Cases within a suite run one at a time unless the suite registers with
`registerCase(..., { concurrent: true })`, and then at most four at a time,
even under a bare `bun test`. Only mark suites whose cases share
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

Set `CORGI_OLD_EXE` to a test-enabled binary from the previous release when
running `updates`; its first fixture version then uses that binary to exercise
the real cross-version handoff.

`--check` parses and bundles the suites without executing them; it is not a
replacement for running the tests. The former smoke suite is split into
`smoke`, `smoke_input`, and `smoke_terminal`. Scenarios retain their original
names where the behavior is unchanged; UI checks follow the current shortcut
help and new-tab agent picker.

Developer-launch tests invoke `go.ts` and are opt-in (`bun run tests/run.ts dev`).
They expect the fixture binary to match the developer build. The alternate-build
reload case additionally needs `CORGI_OLD_EXE`. On macOS the fixture discovers
the host signing identity before isolating `HOME`; the developer build must
already be available in the compiler cache.
Live Herdr handoff is also opt-in:

```sh
bun run tests/run.ts herdr_handoff --corgi dist/corgi-test --herdr /path/to/herdr
```

`support.ts` owns process deadlines, buffered line readers, raw JSON sockets,
and PTYs. `viewer_client.ts` drives the actual viewer protocol. `runtime.ts`
owns isolated daemon setup and cleanup. Provider fixtures live in
`provider_sim.ts` and `inference_harness.ts`. Shared fixture modules do not
register tests when imported; `.test.ts` entry points register their scenarios
with Bun's test runner. The small assertion adapter preserves scenario names
and assertion intent from the original suites.

Disposable runtimes and the suite runner use `scripts/process_scope.ts` to
tag their subprocesses and start a detached watchdog. The tag survives
daemon reloads and reparenting. When an owner exits, including after SIGKILL,
the watchdog terminates its remaining processes and escalates to SIGKILL.
Scopes nest, so concurrent suites do not clean up each other's processes.
Pass the scope's environment to every subprocess; do not clear its
`CORGI_PROCESS_SCOPE` marker. As a second guard, a runtime's
`CORGI_TEST_OWNER` names the test process, and a test build's daemon stops
once that process is gone.

Normal teardown requests shutdown and verifies process exit. A surviving
daemon or a process reaped by the watchdog fails the test. Cleanup failures
retain the runtime directory and log for diagnosis. The UI probe uses the
same protection. Persistent `go.ts --temp` environments still have their
documented independent lifetime.

PTY restoration checks compare `stty -g` snapshots on the same reusable
terminal before and after the client, including control characters and speeds.

## Which tier

Write a unit test beside the module (`src/foo.test.ts`) when the behavior is
a decision or a data transform: layout and session edits, argument parsing,
protocol encoding, render output for a given view, provider event
interpretation, state migrations, error and rollback paths. Build the state
in the test, as `session.test.ts` builds workspace models without shells and
`cli.test.ts` parses command lines without a daemon. Pass `now` in rather than
sleeping or starting timers.

Write a Bun case when the behavior crosses a process, PTY or socket: the CLI
reaching the daemon, a viewer attaching, a reload handing off live shells, a
provider hook arriving, terminal bytes reaching a pane. One case per path is
enough; the decisions behind it have unit tests.

When a Bun case asserts many variants of one decision (capacity limits,
glyph shapes, every usage error), move the variants into a unit test and
keep one Bun case that proves the path. Delete a Bun case only when unit
tests cover what it asserted and another case still covers its path.

## Waiting

A test waits on the daemon, never on the time it might take:

- To assert that something happened, `until()` it. `until` re-checks when the
  daemon pushes a changed session, and at least every 100 ms.
- To assert that something did not happen, `settle()` first, then assert.
  `settle` returns once the daemon's workers have read everything written so
  far. A hook RPC is handled before it replies, so an assertion right after
  one needs no wait.
- To let a policy window pass (cooldowns, rescans, hover cards), `advance()`
  the daemon's clock, or a viewer's with `viewer.advance()`.
- `sleep()` is for real-time behavior only, such as escape-key timing or a
  real child process, with a comment saying which.

`sleep_budget.test.ts` caps the number of sleeps in `tests/*.ts`. Lower its
budget when you remove one; a new sleep has to raise it.
