# Releases and automatic updates

Corgi release installations download signed updates in the background and activate
them on the next `corgi` launch. Development builds (`./go.sh`) never auto-update.
Clients use HTTPS, curl, and an embedded Ed25519 public key; they know nothing about
B2 or S3. The publisher uses Bun and an S3-compatible endpoint.

## One-time publisher setup

Run the publisher on an Apple Silicon Mac with Zig 0.15.2, Bun, and a persistent
macOS code-signing certificate with its private key. `scripts/sign-macos` discovers
a Developer ID Application or Apple Development identity; you can configure one
explicitly. Developer ID is the appropriate identity for general external
distribution. Apple Development is useful for early private testing; this script
does not notarize releases or promise Gatekeeper approval for quarantined files.

Create an Ed25519 release key **outside the checkout**, and back it up securely:

```sh
./scripts/release --init-key "$HOME/.config/corgi/release-key.pem"
```

Create `~/.config/corgi/release.json` (or set `CORGI_RELEASE_CONFIG`):

```json
{
  "publicBaseUrl": "https://corgi.computer",
  "endpoint": "https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com",
  "region": "auto",
  "bucket": "your-corgi-releases",
  "signingKey": "/Users/you/.config/corgi/release-key.pem",
  "credentialsFile": "/Users/you/.config/corgi/r2-credentials.json",
  "codesignIdentity": "Developer ID Application: Your Name (TEAMID)"
}
```

`publicBaseUrl` must map to the **root of this bucket**, including any CDN routing
prefix. Use a stable domain you control so you can move storage without replacing
installed clients. Public reads must work without authentication. Do not cache
`channels/*` or `install.sh` beyond their `no-cache` headers. The endpoint is the
S3 API endpoint without a bucket suffix. For R2, use region `auto`, create a
bucket named `corgi`, and connect the chosen public hostname under the bucket's
Settings → Custom Domains. The domain must belong to the same Cloudflare account.
The publisher does not send per-object ACLs. R2's `r2.dev` address can be used for
initial testing, but Cloudflare limits it and recommends custom domains for production.

Create an R2 API token with **Object Read & Write**, restricted to the `corgi`
bucket. Export its Access Key ID as `AWS_ACCESS_KEY_ID` and Secret Access Key as
`AWS_SECRET_ACCESS_KEY`. Keep credentials out of the repository and shell scripts.
These AWS-named variables are also used for R2; no AWS account is involved.

Alternatively, set `credentialsFile` to a private JSON file outside the repo:

```json
{"accessKeyId": "YOUR_ACCESS_KEY_ID", "secretAccessKey": "YOUR_SECRET_ACCESS_KEY"}
```

Set its permissions with `chmod 600`. The publisher loads it automatically, so
you do not need to export credentials before every release. A complete pair of
environment variables takes precedence; partial environment credentials fail
rather than being mixed with file credentials.

B2 remains supported by changing the endpoint, region, bucket, and credentials;
clients continue to use the same public hostname.

## Publish both platforms with one command

```sh
./publish.sh --dry-run
./publish.sh
```

The root script forwards all arguments to `scripts/release`. The command runs Zig and updater integration tests, builds and signs macOS arm64
(macOS 13+) locally using the SDK selected by `xcrun`, cross-compiles a
static Linux amd64 musl executable, checks both binary formats, and embeds the
version, source commit, feed URL, and public key. It signs a manifest, uploads
immutable artifacts, and verifies their public downloads before advancing
`channels/stable.json`. No Git tags or remotes are changed. Version numbers are
UTC datetime plus the first 12 Git hash characters (for example,
`20260925T183012Z-be82c7b9090a`). Both binaries and the signed manifest include the
full source commit. Never reuse a version for different bytes.

Publishing pins the commit at HEAD when the command starts and builds it in a
temporary detached Git worktree. Staged, unstaged, and untracked changes are
excluded. Your index, working files, and development `zig-out` and `.zig-cache`
directories stay untouched, so you can keep editing, building, and committing
while it publishes. The installer template also comes from the pinned commit.
The existing publisher drives the release using your usual external configuration,
signing keys, and Zig compiler (including a compiler installed under `.tools`).

Isolated artifacts are saved in `corgi-releases/VERSION` under the repository's
common Git directory (normally `.git/corgi-releases/VERSION`); the exact location
is printed. The temporary worktree and its build cache are removed on completion
or a build/upload error. Saved artifacts remain available for retry:

```sh
./publish.sh 20260925T183012Z-be82c7b9090a --publish-only
```

This resumes the saved source commit even if you have made newer commits or have
pending edits, without rebuilding timestamped signatures. The configuration must
still match the prepared release. Previously prepared releases under
`zig-out/releases/VERSION` can also be resumed; the publisher checks that location
if the version is absent from the new directory. A local publisher lock in the
common Git directory serializes runs across linked worktrees of this repository.
Use a **single publishing host**
or a CI concurrency group: object-store publication is not a distributed transaction.
Existing assets with different bytes are rejected. Stable cannot move backwards.

For a build-only check of committed HEAD:

```sh
./scripts/release --build-only
```

Build-only results are not publishable. `codesignIdentity: "-"` permits an ad-hoc
macOS build in this mode only. For Linux the script verifies that the ELF has no
dynamic interpreter; executing Linux integration tests still requires Linux.

## Install and use

```sh
curl -fsSL https://corgi.computer/install.sh | bash
# Accept the PATH setup prompt, then open a new terminal.
corgi
```

The installer is a short, readable shell script generated from
[`scripts/install.sh.in`](../scripts/install.sh.in). It needs only curl and standard
macOS/Linux utilities and runs without sudo. If `~/.local/bin` is missing from
PATH, it asks before adding a line to the current shell configuration (bash, zsh,
or fish). The prompt reads `/dev/tty`, so piping the script to bash still works.
It leaves existing configuration intact and avoids adding duplicate lines.
Without a terminal it prints the PATH command instead; `CORGI_UPDATE_PATH=1`
opts into configuration for unattended installs, and `CORGI_UPDATE_PATH=0` skips
it. Open a new terminal afterward, or run the printed command in the current one.

The installer pins the initial binary's checksum, then the binary verifies the
signed release manifest before installing. As with any shell installer, the
initial script is trusted through its HTTPS origin. The installer refuses to
overwrite an existing `corgi` command or managed installation.

`~/.local/bin/corgi` is a small launcher. Executables and their signed manifests
live in private version directories under `~/.local/share/corgi/releases`.
`CORGI_INSTALL_ROOT` and `CORGI_INSTALL_BIN` can customize initial installation
using absolute paths. Old binaries are retained: other runtimes and viewers may
still use them. Automatic garbage collection is deliberately not implemented.

While a runtime is running, a detached worker checks about once an hour (with
jitter), downloads to a temporary file, verifies its size/hash/signature, and
stages it atomically. Workers share a download lock. Errors never interrupt the
terminal; `corgi update status` exposes background errors.

The next launch uses local staged files, even offline. A small animated corgi
shows “Updating…” while activation runs. There is no artificial minimum delay.
With no runtime, the candidate must successfully start and answer a health check
before it becomes current. With a runtime, a compatible live handoff preserves
pane PIDs and compatible viewers. A rejected candidate leaves the old runtime
serving. A lost handoff reply is reconciled against the running executable.

When a handoff cannot be performed safely, Enter/Escape keeps working on the old
executable. `r` offers restart, followed by typing `restart` to explicitly stop
all shells/agents and disconnect other viewers. A recovery backup is saved first.
Cold recovery restores context in new shells; it cannot resurrect processes.
The same release is not prompted again for that runtime PID after skipping.
Noninteractive calls and calls inside a Corgi pane never confirm a restart.

```sh
corgi --no-update             # skip activation this launch
corgi update                 # explicitly download and try activation
corgi update --check
corgi update --download-only
corgi update status
corgi update rollback        # same handoff/restart rules
corgi update auto off
corgi update auto on
```

Rollback suppresses automatic reinstallation of that release and older releases;
a newer version or explicit `corgi update` can override it. Ordinary commands,
hooks, and RPC calls do not activate updates or perform network checks. Explicit
update failure/deferment returns a nonzero exit status. Compatible existing
viewers keep their current UI code until they next attach; processes are not
restarted merely to refresh a viewer.

## Compatibility and trust contract

`src/updates.zig` defines a compatibility epoch combined with the pinned Ghostty
dependency hash. **Bump that epoch whenever a runtime/checkpoint/viewer change
cannot safely coexist across versions.** The candidate validates it during
handoff as well as the updater checking it before handoff. Marketing/release
version changes do not change the terminal checkpoint fingerprint.

The manifest is one JSON envelope containing the exact signed `payload` string
and a hexadecimal Ed25519 signature. Schema 1 requires both supported targets,
each with an HTTPS URL, SHA-256, and byte size. Production builds reject HTTP;
`-Dupdate-test-mode=true` exists only for isolated localhost fixtures and is never
used by the publisher. Preserve the release key: key rotation requires an
explicit client migration, not merely changing a bucket setting.

## Validation

```sh
./scripts/zig build test
bun test tests/release.test.ts
bun test tests/updates.test.ts
```

The updater suite builds two test releases and runs isolated real daemons against
a signed localhost feed. It verifies process-preserving updates, rollback,
background staging, offline activation, signature/checksum rejection, and
noninteractive deferral. It does not use the host Corgi runtime or B2 credentials.

## Retention

All published versions are retained in R2. There is no automatic deletion. Only
`install.sh` and `channels/stable.json` move forward; versioned artifacts stay
immutable for existing installers and rollback.

The production public base URL is `https://corgi.computer`, connected directly to
the R2 bucket. Keep the original `r2.dev` endpoint enabled for older installations
and pinned releases; new releases embed the custom domain and existing clients
transition when they install an update.
