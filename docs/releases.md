# Releases

The publisher builds committed HEAD for macOS arm64 and Linux amd64 and arm64 in
an isolated checkout. Pending edits are excluded. Once the release is live, it
tags the commit on `origin` with the version; local branches and tags are untouched.

Linux arm64 has its own manifest and channel (`manifest-linux-aarch64.json`,
`channels/stable-linux-aarch64.json`): releases before it reject a manifest that
names a target they don't know, so `manifest.json` and `channels/stable.json`
keep only macOS arm64 and Linux amd64. A new target gets its own the same way.

## Setup

Use an Apple Silicon Mac (or Linux, [below](#publishing-from-linux)) with Bun, the [pinned Zig toolchain](../AGENTS.md#zig-toolchain),
Xcode's SDK and a persistent macOS signing identity. Keep signing keys and storage
credentials outside the repository. Use one publishing host at a time. The host
needs push access to `origin` on GitHub, and the release commit must already be on
origin's `main`; both are checked before building.
The publisher also needs push access to `tals/corgi-omarchy` (SSH by default).

Create and back up the release signing key:

```sh
bun run publish --init-key "$HOME/.config/corgi/release-key.pem"
```

Create `~/.config/corgi/release.json` (or select it with `CORGI_RELEASE_CONFIG`):

```json
{
  "publicBaseUrl": "https://corgi.computer",
  "endpoint": "https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com",
  "region": "auto",
  "bucket": "corgi",
  "signingKey": "/Users/you/.config/corgi/release-key.pem",
  "credentialsFile": "/Users/you/.config/corgi/r2-credentials.json",
  "codesignIdentity": "Developer ID Application: Your Name (TEAMID)"
}
```

The credentials file contains `accessKeyId` and `secretAccessKey`; make it private
with `chmod 600`. Alternatively, set both `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`; a complete environment pair takes precedence.

The public URL must serve the bucket root over HTTPS without authentication.
Honor the `no-cache` headers on `channels/*` and `install.sh`.
Optional `notaryProfile` enables notarization. Optional `sentry` supplies `dsn`,
`org` and `project`; publishing then needs an authenticated `sentry-cli` to upload
debug symbols. Configuration fields live in [scripts/publish.ts](../scripts/publish.ts).

### Publishing from Linux

[rcodesign](https://github.com/indygreg/apple-platform-rs) signs and notarizes
the macOS binary without a Mac. Install it (`cargo install apple-codesign`),
plus `zip` and LLVM's `dsymutil` and `llvm-dwarfdump` (a versioned copy such as
`dsymutil-18` is found too). Copy Xcode's macOS SDK to `.tools/macos-sdk`, or
name it with `macosSdk`.

On the Mac that publishes, `scripts/send-release-keys.sh` sends the release
config and keys to the Linux host, with the `codesignIdentity` certificate and
its private key as a `.p12`. To notarize too, pass it an App Store Connect API
key with the Developer role (`--notary-key AuthKey_KEY_ID.p8 --issuer
ISSUER_ID`); notarizing needs a Developer ID Application certificate.

By hand, export the certificate with its private key from Keychain Access as a
`.p12` and encode the API key:

```sh
rcodesign encode-app-store-connect-api-key -o ~/.config/corgi/notary-key.json ISSUER_ID KEY_ID AuthKey_KEY_ID.p8
```

Then replace `codesignIdentity` and `notaryProfile` with the following, and make
all three files private with `chmod 600`:

```json
  "codesignP12": "/home/you/.config/corgi/codesign.p12",
  "codesignP12PasswordFile": "/home/you/.config/corgi/codesign.pass",
  "notaryApiKey": "/home/you/.config/corgi/notary-key.json"
```

rcodesign refuses certificates Apple did not issue. A Linux publisher runs
only the Linux binary's smoke test; the macOS binary is checked by its
signature (and Apple's notarization), not run.

## Release checklist

1. Commit and push the changes to ship. Review compatibility changes using
   [HACKING.md](../HACKING.md).
2. Check the selected commit and output paths with `bun run publish --dry-run`.
3. Run `bun run publish`. It tests, builds, signs and verifies the public downloads
   before advancing the stable channel, then tags the commit on GitHub and updates
   the Omarchy plugin when needed. Wait for the command to finish.
4. From an installed copy, run `corgi update --check` to confirm the offered release.

Versions are immutable; never reuse a version for different bytes or casually
replace the signing key trusted by existing installations. Published versions
remain available for existing installers and rollback.

Local binaries and debug symbols stay under `.git/corgi-releases/` (the common
Git directory for linked worktrees). Keep the symbols needed for crash diagnosis;
with `sentry` configured, publishing uploads them. `bun run publish --clean` then
deletes every saved release, published or not, and the checkouts that
interrupted runs left behind.
For build-only and retry options, use `bun run publish --help`.

## Omarchy and test releases

`bun run publish` first fetches `corgi-omarchy` into the saved release directory,
before running tests or builds. Once Corgi is built, it calls the plugin's
`tools/release-plugin` with the exact Corgi source and installer.
The plugin owns regeneration, checks, and deciding whether anything needs pushing.
It keeps its installer pin for binary-only Corgi releases. Plugin preparation runs
before Corgi is published; the plugin push follows verified Corgi downloads.
Use `--omarchy-skip` to skip both steps. No companion checkout is required.

If the plugin push fails after Corgi is published, retry the saved release:

```sh
bun run publish VERSION --publish-only
```

To publish a build for your own testing:

```sh
bun run publish --test
```

This builds the same production binaries, with a separate update key and downloads
under `https://corgi.computer/test`. The commit must be pushed to origin, but may be
on a feature branch. Its tag is `test/VERSION`. Stable downloads, channels, and the
plugin's `main` branch stay untouched. Test builds do not send crash reports.
The output includes both installation paths:

```sh
curl -fsSL https://corgi.computer/test/install.sh | bash
omarchy plugin add https://corgi.computer/test/corgi.computer.git --enable
```

The normal installer also selects the test plugin when it detects Omarchy.
The test plugin points to this exact build. Subsequent test releases advance that
channel; use `corgi update` and `omarchy plugin update corgi.computer` in the sandbox.
To resume a failed test publication, add `--test` to `VERSION --publish-only`.

Test artifacts live under `.git/corgi-test-releases/`. The persistent test signing
key is `.git/corgi-test-signing.pem`; `--clean` removes artifacts but keeps this key.
Back it up if you want existing test installations to keep accepting new updates.

For plugin-only changes, run `./tools/release-plugin` in `corgi-omarchy`, or add
`--test` to publish its test version. It fetches the Corgi sources it needs without
building Corgi. See that repository's HACKING.md for the plugin's release policy.

`CORGI_OMARCHY_REMOTE` overrides the plugin Git remote for development or another
authentication method. `--dry-run` describes the selected destination without
building, generating keys, cloning, or changing remotes.
