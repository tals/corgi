# Integration tests

Corgi, the test harness and the provider fixtures all run on Bun.
No integration test or generated provider program requires Python.

Build the test-enabled binary, then run the suites:

```sh
bun build.ts --test       # dist/corgi-test, the default CORGI_TEST_BIN
bun integration.ts        # or: bun run tests/run.ts
```

The wrapper selects suites and runs them with Bun's `--parallel` worker pool
and file isolation (`--jobs N`, default a quarter of the cores, at most 2).
Bun streams test results and owns scheduling, sharding, and duration history.
`--list` lists eligible files before sharding; `--shard K/N` lets Bun choose
one slice. `--retry` reruns failed files once more, alone in fresh processes,
and reports recovered suites as flaky. The subprocess watchdog still checks
for leaked daemons before the run succeeds.

Local durations live in `.zig-cache/integration-timings/local.json`, in Bun's
`--timings` format (milliseconds). CI restores the previous run's per-platform
timings once in the build job and ships that same baseline to every shard.
Bun balances shards by duration and starts slow files first. Each shard writes
its own timings; successful runs combine and cache them for the next run.
The old `.zig-cache/test-timings.json` is no longer used.

`progress.ts` is both the runner's reporter and a Bun preload. Workers record
individual test starts and finishes; the parent prints counts and updates an
existing Actions job every ten seconds. In CI, `GITHUB_TOKEN` with `checks: write`
and `CORGI_TEST_CHECK_ID` from `${{ job.check_run_id }}` select that job's check.
The reporter never creates checks or commit statuses, so each integration shard
has one row, with details such as `49/101 · 48% · ~2m left`. Job names are set in
the workflow. GitHub still adds its workflow/event labels and status
prefix. Actions owns the job's final result, including cancellation and failures
in later steps. The details link and logs stay attached to the original job.
Local runs and read-only fork tokens keep ordinary logs. GitHub API failures
never change the test result.

Live counts cover test attempts, with a separate phase for each retry. A quick
Bun invocation filters out all tests and writes a JUnit inventory first, using
the same shard and timing inputs without updating timing history. It imports
suite modules but runs no test bodies or lifecycle hooks. This supplies the
percentage's denominator, including skipped and name-filtered tests; skips
are accounted for when the run finishes. If inventory is unavailable, the
counts remain available in the detailed report. The final JUnit report supplies
pass/fail/skip totals and the job summary. A failed test process or leaked daemon
still fails the check even if the report has no failed assertions.
Create suite resources in startup hooks so counting tests needs no cleanup.

The time estimate uses cached durations for the selected shard and its worker
count. It is omitted without complete timing history or with custom Bun flags.
Retries use the preceding attempt's duration. It counts down from that estimate;
if the run takes longer, it shows `past estimate` until completion. It estimates
test execution only, excluding build and cleanup time.

Cases within a suite run one at a time unless the suite registers with
`registerCase(..., { concurrent: true })`, and then at most two at a time,
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

`CORGI_OLD_EXE=/path/to/previous/corgi bun integration.ts reload_compatibility`
checks automatic developer switchover and explicit reload from an older
daemon, discovering its runtime protocol through management hello. The old
binary need not be test-enabled. Both checks preserve a live shell's PID and
verify it still accepts input after handoff.

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

`codex_overload` runs the installed Codex (or `CODEX_TEST_BIN`) against a
fake model that is at capacity a few times, and is opt-in too
(`bun run tests/run.ts codex_overload`, or `--external`). Its Codex home
takes a copy of Codex's app-server package, about 500 MB, while it runs.

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
retain the runtime directory and log for diagnosis. The UI driver uses the
same protection. `go.ts --temp` environments survive detach, but the next
`--temp` launch stops older temporary runtimes unless passed `--no-kill`.

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

`settle()` does not wait for a child process to finish starting or for replies
on another socket to reach the test. Before measuring watcher silence, wait
for the child's ready marker and expected foreground command in the session.
Then settle and send `ping` on the watch socket: count every notification
before its reply. Discarding currently buffered lines is not a delivery barrier.

`sleep_budget.test.ts` caps the number of sleeps in `tests/*.ts`. Lower its
budget when you remove one; a new sleep has to raise it.
