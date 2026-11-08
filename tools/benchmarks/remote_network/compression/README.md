# Reproduce the compression comparison

This is an offline codec experiment. No Corgi or Herdr application encoding was
changed. Read the [short report](report.md), [method](method.md), or
[complete measurements](measurements.md).

Run from the repository root. Requirements: Bun and the built native terminal
layer, Python 3, a C compiler, zlib headers/library, and zstd 1.5.5 headers/library.
The measured environment used GCC 13.3.0, zlib 1.3, and an AMD EPYC 7C13, pinned
to CPU 48. Choose an available CPU with `--cpu`. The runner holds the shared
`/tmp/corgi-cpu-benchmark-<uid>.lock` during training and measurement.

```sh
mkdir -p dist/zstd-include
curl -fsSL https://raw.githubusercontent.com/facebook/zstd/v1.5.5/lib/zstd.h \
  -o dist/zstd-include/zstd.h
curl -fsSL https://raw.githubusercontent.com/facebook/zstd/v1.5.5/lib/zdict.h \
  -o dist/zstd-include/zdict.h
cc -O3 -Wall -Wextra -Werror -I dist/zstd-include \
  tools/benchmarks/remote_network/compression_bench.c \
  -Wl,-l:libzstd.so.1 -lz -o dist/compression-bench

bun tools/benchmarks/remote_network/compression_corpus.ts dist/zstd-test-fixtures
bun tools/benchmarks/remote_network/compression_corpus.ts \
  dist/zstd-train-fixtures tools/benchmarks/remote_network/compression/fixtures \
  claude codex
```

Create **fresh** network captures using the [capture playbook](../wire-efficiency/README.md).
The application binary in these measurements was `dist/corgi-throughput-after`,
from application revision `9eff77f4`:

```sh
python3 tools/benchmarks/remote_network/wire_capture.py \
  /path/to/corgi dist/zstd-new-sparse --kind sparse
python3 tools/benchmarks/remote_network/wire_report.py dist/zstd-new-sparse
python3 tools/benchmarks/remote_network/wire_capture.py \
  /path/to/corgi dist/zstd-new-dense --kind dense
python3 tools/benchmarks/remote_network/wire_report.py dist/zstd-new-dense

python3 tools/benchmarks/remote_network/compression_run.py \
  --train-fixtures dist/zstd-train-fixtures \
  --fixtures dist/zstd-test-fixtures \
  --test-sparse dist/zstd-new-sparse --test-dense dist/zstd-new-dense \
  --binary dist/compression-bench --out dist/zstd-rerun \
  --cpu 48 --repeats 3 --target-ms 80
```

The runner checks capture bytes against syscall payloads, rejects source or
exact-message overlap, and checks that training and test agent scenario hashes
differ. It trains 8 KiB and 32 KiB dictionaries on the **same training corpus**,
then tests all preselected levels and context modes in shuffled order. Training
samples also use a fixed shuffle; the 32 KiB cap produced a 16,249-byte dictionary
in this run. Every
trial decodes each message immediately and checks exact equality, before and
after the timed passes. `results.jsonl` contains individual trials;
`summary.json` contains medians and ranges. Corpus files contain a little-endian
u32 message count, followed by u32 byte lengths and unmodified message bytes.

To rerun one cell of the matrix:

```sh
taskset -c 48 dist/compression-bench dist/zstd-rerun/claude.corpus \
  zstd-frame 3 dist/zstd-rerun/agent-training-32768.dict 80
taskset -c 48 dist/compression-bench dist/zstd-rerun/claude.corpus ssh 1 - 80
```

To record new training sessions, use the optional scenario input added to the
existing recorder. It runs the real CLI against a local canned-response server
in a disposable home; it does not call a model or use personal credentials.
The checked-in recordings avoid requiring either CLI for an exact codec rerun.

```sh
bun tools/benchmarks/frame_sequences/record.ts claude dist/new-training \
  tools/benchmarks/remote_network/compression/training-scenario.json
bun tools/benchmarks/frame_sequences/record.ts codex dist/new-training \
  tools/benchmarks/remote_network/compression/training-scenario.json
```

Use a different scenario from the held-out test recordings. The recorder's
default scenario is the **test** TypeScript/checklist answer; do not use it for
training. Fresh recordings and network captures vary; the archive linked from
the report preserves the exact measured inputs, dictionaries and trials.

For an exact-input rerun, extract that archive into an empty directory and point
the runner's `--fixtures`, `--train-fixtures`, `--test-sparse`, and `--test-dense`
arguments at its `dist/zstd-fixtures`, `dist/zstd-training-fixtures`,
`dist/zstd-test-sparse`, and `dist/zstd-test-dense` directories. This skips
recapture and replay. The artifact manifest contains the archive SHA-256 and
per-file hashes. The saved `.corpus` files also work directly with the C harness.

Validation for this change: 456 byte-exact codec trials, all four codec modes
under AddressSanitizer/UndefinedBehaviorSanitizer, warning-clean C compilation,
3,375 unit tests passing (one opt-in skip), and typecheck/format passing.
[Validation record](evidence/validation.json).
