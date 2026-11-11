# Benchmark code and data

The Corgi/Herdr network harness stays in this repository. Results, reports,
captures, replay corpora and run manifests belong outside it. This covers
`remote_network/`, `control_priority/`, `local_scale/` and `websocket_transport/`.
The curated `frame_sequences/` unit-test fixtures are separate.

| What | Location |
| --- | --- |
| Harness, generators, reducers and reproduction instructions | `tools/benchmarks/` |
| Local runs and downloads | `$XDG_CACHE_HOME/corgi/benchmarks/<run-id>/` (default `~/.cache/corgi/benchmarks/`) |
| Frozen local bundles | `<cache>/.archives/<run-id>/` |
| Durable results | `s3://corgi-benchmarks/network/<run-id>/{archive.tar.gz,manifest.json}` |

Use `CORGI_BENCHMARK_CACHE` to choose another local directory. It must be
outside the checkout, including when reached through a symlink. Reports and
relative evidence links travel together. The bucket is private.

## Results index

The [R2 bucket browser](https://dash.cloudflare.com/?to=/:account/r2/default/buckets/corgi-benchmarks)
and this command list the stored results. The CLI lists only completed runs,
identified by a verified manifest:

```sh
bun tools/benchmarks/artifacts.ts list
bun tools/benchmarks/artifacts.ts fetch RUN_ID
```

`fetch` prints the local directory. An optional second argument chooses a fresh
destination. It checks the archive hash and each file's bytes, size and mode
before exposing the extracted directory; it never overwrites an existing run.

## Run and publish

Requires Bun and Python 3.12 or newer. Storage operations run outside measurement
windows. No application transport code imports this tooling.

```sh
RUN=$(bun tools/benchmarks/artifacts.ts new network)

# Build first. Supply the stock Herdr binary separately.
bun build.ts
python3 tools/benchmarks/remote_network/run.py \
  corgi "$PWD/dist/corgi" "$RUN/corgi" --calibrate
python3 tools/benchmarks/remote_network/run.py \
  herdr /absolute/path/to/herdr "$RUN/herdr"

# Keep reductions, authored reports and evidence inside $RUN too.
# Freeze only after producers and reducers have finished writing.
bun tools/benchmarks/artifacts.ts pack "$RUN"
bun tools/benchmarks/artifacts.ts publish "$(basename "$RUN")"
```

The remote runner's optional output argument and the TS runners' default output
paths use fresh cache directories. Coordinators/reducers with required output
arguments should receive paths underneath `$RUN`. Binaries may remain in `dist`.
Historical recipes use the original author's `dist` and `/tmp` locations; replace
their **data/output** paths with `$RUN` paths when running the current harness.

`pack` freezes regular files into a deterministic archive and records their
SHA-256 hashes. It refuses links and special files. The manifest records the
packaging checkout's revision and dirty flag; individual trial manifests remain
the authority for measured binaries, options and harness identity. Packing is
not a claim that the packaging checkout produced the measurements.

`publish` uses conditional writes so a run ID cannot be overwritten. It reads
the uploaded archive back and checks its hash before uploading the completion
manifest, then reads that back too. An interrupted upload can be retried with
the same frozen bundle. Changed results need a new run ID. Bundles larger than
5 GiB must be split into separate runs. No command deletes local or remote data.

## Credentials

Create the private R2 bucket `corgi-benchmarks` and grant its S3 credentials object
read/write access. Set `CORGI_BENCHMARK_CONFIG` to a local file,
or use `~/.config/corgi/benchmarks.json`:

```json
{
  "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
  "region": "auto",
  "bucket": "corgi-benchmarks",
  "credentialsFile": "/absolute/path/to/benchmark-credentials.json"
}
```

The credential file contains `accessKeyId` and `secretAccessKey`. A complete
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` environment pair takes precedence.
Without a dedicated config, the tool reuses the endpoint/credential location
from `CORGI_RELEASE_CONFIG` or `~/.config/corgi/release.json`, but always selects
`corgi-benchmarks`. It never writes into the release bucket.
Neither credentials nor signed URLs belong in reports or Git.

## Historical migration

The migration run is `20261111-network-history-d08257db`. Its files retain their
repository paths, including these report entry points:

```text
tools/benchmarks/remote_network/adaptive-production/report.md
tools/benchmarks/remote_network/websocket_codecs/report.md
tools/benchmarks/control_priority/report.md
tools/benchmarks/local_scale/README.md
tools/benchmarks/websocket_transport/README.md
```

**Pending storage access:** the verified local snapshot is prepared, but the R2
upload has not succeeded. Tracked historical data remains until upload and a
fresh download have both been verified. Update this section when migration
finishes; this run is not yet available from the remote results index.

The snapshot retains the exact old harness and playbooks. Source commits are
reachable through `benchmarks/remote-v3-before-main-20261108`. Removing files
from the current tree does not purge them from Git history.

Replay tools load sparse/dense/Claude/Codex captures from the fetched historical
run. Set `CORGI_BENCHMARK_CORPUS` to another external directory with the same
corpus files and `manifest.json` to use another dataset. Payload hash checks
remain active; downloading never happens during a trial.

## Check the tooling

```sh
bun test ./tools/benchmarks/artifacts.test.ts
```

Tests exercise the actual S3 client against a local HTTP server: conditional
writes, retries, corrupted transfers and incomplete publication. They also
exercise packing/extraction and the checkout path guard.
