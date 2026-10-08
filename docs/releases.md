# Releases and automatic updates

Corgi release installations download signed updates in the background and activate
them on the next `corgi` launch. Development builds (`./go.ts`) never auto-update.
Clients use HTTPS, curl, and an embedded Ed25519 public key; they know nothing about
B2 or S3. The publisher uses Bun and an S3-compatible endpoint.

## One-time publisher setup

Run the publisher on an Apple Silicon Mac with Zig 0.16.0, Bun, and a persistent
macOS code-signing certificate with its private key. Without `codesignIdentity`,
the publisher uses the keychain's one Developer ID Application identity (or else
its one Apple Development identity). Developer ID is the appropriate identity for
general external distribution; Apple Development is useful for early private testing.

The macOS binary is signed with the hardened runtime and the JIT entitlements Bun
needs (`scripts/entitlements.plist`); the native libraries it embeds are signed by
the same identity first. To notarize as well, store App Store Connect credentials
with `xcrun notarytool store-credentials` and name the profile as `notaryProfile`.
Notarization matters only for files a browser downloads; the installer's curl
download is not quarantined.

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
  "codesignIdentity": "Developer ID Application: Your Name (TEAMID)",
  "notaryProfile": "corgi-notary",
  "sentry": {
    "dsn": "https://KEY@oORG.ingest.us.sentry.io/PROJECT_ID",
    "org": "your-org",
    "project": "corgi"
  }
}
```

`notaryProfile`, `macosSdk` and `sentry` are optional; see
[Crash reports](#crash-reports) for `sentry`. `macosSdk` names the macOS SDK to
build against; the default is Xcode's on a Mac and `.tools/macos-sdk` elsewhere.

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

The root script forwards all arguments to `scripts/release`. The command runs the
typecheck, unit tests and the release and updater integration suites. It then
compiles both platforms with Bun: Linux amd64 (glibc 2.28 or newer) and macOS arm64
(macOS 13+, against the SDK selected by `xcrun`). It signs the macOS binary, checks
both binary formats, and starts the Mac's binary on a private runtime to run a shell
in a pane. Both binaries embed the version, source commit, feed URL, and public key. It signs a manifest, uploads
immutable artifacts, and verifies their public downloads before advancing
`channels/stable.json`. No Git tags or remotes are changed. Version numbers are
UTC datetime plus the first 12 Git hash characters (for example,
`20260925T183012Z-be82c7b9090a`). Both binaries and the signed manifest include the
full source commit. Never reuse a version for different bytes.

Publishing pins the commit at HEAD when the command starts and builds it in a
temporary detached Git worktree. Staged, unstaged, and untracked changes are
excluded. Your index, working files, and development `dist`, `native/zig-out` and
`native/.zig-cache` directories stay untouched, so you can keep editing, building, and committing
while it publishes. The installer template also comes from the pinned commit.
The existing publisher drives the release using your usual external configuration,
signing keys, Zig compiler and macOS SDK (including copies under `.tools`).

Isolated artifacts are saved in `corgi-releases/VERSION` under the repository's
common Git directory (normally `.git/corgi-releases/VERSION`); the exact location
is printed. The temporary worktree and its build cache are removed on completion
or a build/upload error. Saved artifacts remain available for retry:

```sh
./publish.sh 20260925T183012Z-be82c7b9090a --publish-only
```

This resumes the saved source commit even if you have made newer commits or have
pending edits, without rebuilding timestamped signatures. The configuration must
still match the prepared release. A local publisher lock in the
common Git directory serializes runs across linked worktrees of this repository.
Use a **single publishing host**
or a CI concurrency group: object-store publication is not a distributed transaction.
Existing assets with different bytes are rejected. Stable cannot move backwards.

For a build-only check of committed HEAD:

```sh
./scripts/release --build-only
```

Build-only results are not publishable. `codesignIdentity: "-"` permits an ad-hoc
macOS build in this mode only, and lets the build run on Linux too: Zig and Bun
cross-compile the macOS binary against `.tools/macos-sdk`, and the smoke test runs
the Linux binary instead. Signing still needs the Mac.

## Crash reports

With `sentry` configured, release builds embed the DSN (`-Dsentry-dsn`) and the
daemon and viewer report fatal signals in the native layer and uncaught
JavaScript exceptions to that Sentry project (a native project; the free plan
is enough). Development builds have no DSN and
send nothing. sentry-native's in-process handler saves a report under
`$XDG_STATE_HOME/corgi/crash` (default `~/.local/state/corgi/crash`); the next
daemon or viewer to start posts it with curl. A report that fails to send is
dropped. Hooks and other short CLI commands do not report.

Native reports carry raw addresses. The publisher keeps the debug info of the
macOS native libraries as dSYMs in `dsym/` beside the release artifacts and,
before any asset goes public, uploads them and the Linux native libraries (which
keep their DWARF, in `native/linux-x86_64/`) with `sentry-cli debug-files
upload`; Sentry symbolicates from those. Install
sentry-cli (`brew install getsentry/tools/sentry-cli`) and authenticate it once
with `sentry-cli login` using an organization auth token, or export
`SENTRY_AUTH_TOKEN`. `--build-only` makes the dSYMs but uploads nothing.

To symbolicate a macOS address by hand, use the library's load address from the
report: `atos -o dsym/libcorgi_probe.dylib.dSYM -arch arm64 -l LOAD_ADDRESS ADDRESS`.

## Install and use

```sh
curl -fsSL https://corgi.computer/install.sh | bash
# Press Enter to start Corgi.
```

The installer is a short, readable shell script generated from
[`scripts/install.sh.in`](../scripts/install.sh.in). It needs only curl and standard
macOS/Linux utilities and runs without sudo. It prints each step and strikes
through the ones an earlier run already did. If `~/.local/bin` is missing from
PATH, it adds a line to the current shell configuration (bash, zsh, or fish),
leaving existing configuration intact and skipping duplicates; open fish
sessions pick it up too. `CORGI_UPDATE_PATH=0` skips this. On a terminal it
ends with a button: Enter starts Corgi, Esc skips. Keys come from `/dev/tty`,
so piping the script to bash still works. Without a terminal it prints plain
lines and the command to run.

The installer pins the initial binary's checksum, then the binary verifies the
signed release manifest before installing. As with any shell installer, the
initial script is trusted through its HTTPS origin. The installer refuses to
overwrite an existing `corgi` command. Over an older managed installation it
downloads its release and stages it, as a background download would; the next
`corgi` launch activates it. Over the same or a newer one it downloads nothing.

`bash -s uninstall` reverses the installer: it removes the launcher, the
install root, the PATH lines it added and Corgi's Ghostty keybindings. It
keeps the PATH lines while other programs live in `~/.local/bin`, keeps saved
state, and refuses while any process runs from the install root.

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

`src/updates.ts` defines a compatibility epoch combined with the terminal
checkpoint fingerprint (`terminal_abi` in `src/persist/handoff.ts`). **Bump that epoch whenever a runtime/checkpoint/viewer change
cannot safely coexist across versions.** The candidate validates it during
handoff as well as the updater checking it before handoff. Marketing/release
version changes do not change the terminal checkpoint fingerprint.

The manifest is one JSON envelope containing the exact signed `payload` string
and a hexadecimal Ed25519 signature. Schema 1 requires both supported targets,
each with an HTTPS URL, SHA-256, and byte size. Production builds reject HTTP;
test builds (`bun build.ts --test`) accept a localhost feed only for isolated
fixtures, and the publisher never ships one. Preserve the release key: key rotation requires an
explicit client migration, not merely changing a bucket setting.

## Validation

```sh
bun build.ts --test
bun test ./tests/release.test.ts ./tests/updates.test.ts
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
