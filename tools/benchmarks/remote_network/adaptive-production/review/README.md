# Reproduce the review checks

Application fixes are in `b0e34828`; the preceding accepted implementation is
`a0156499`. The [original playbook](../README.md) documents the Linux network lab,
stock Herdr binary, and measurement definitions. The reviewed build used Bun 1.4.4
and the same native artifacts. [Exact build identities](evidence/builds.json).

```sh
bun test src
bun typecheck.ts
bun build.ts --no-native --outfile dist/corgi-reviewed
bun build.ts --test --no-native
bun integration.ts remote remote_sandbox reloads reload_snapshots \
  reload_compatibility worktree_reload inference_reload --jobs 1

python3 tools/benchmarks/remote_network/adaptive_matrix.py \
  /absolute/path/to/accepted-corgi \
  dist/corgi-reviewed \
  /absolute/path/to/herdr-v0.9.5 \
  dist/review-network \
  --suites stream-600-low,cadence,transition,faults-sparse,sleep-clean \
  --cpu-start 16 --repeats 3
python3 tools/benchmarks/remote_network/adaptive_report.py \
  dist/review-network dist/review-network-reduction
```

The older local-protocol compatibility cases require `CORGI_OLD_EXE`; they skip
without it. This is unrelated to compatibility with an older remote release:
there has been no released remote daemon, and this change adds no such fallback.

To test-drive the reviewed stream transport in an isolated local environment:

```sh
./go.ts --env remote-test-drive --no-kill
```

This builds the current branch. The named environment has separate Corgi state;
provider accounts remain shared. Add the test machine through the usual machine
setup so both ends use the same build. The command above does not automatically
upgrade any remote machine. The experimental WebSocket binaries are separate
evaluation builds and do not support planned daemon handoff.
