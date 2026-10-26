# Releases

The publisher builds committed HEAD for macOS arm64 and Linux amd64 and arm64 in
an isolated checkout. Pending edits are excluded; Git tags and remotes are untouched.

Linux arm64 has its own manifest and channel (`manifest-linux-aarch64.json`,
`channels/stable-linux-aarch64.json`): releases before it reject a manifest that
names a target they don't know, so `manifest.json` and `channels/stable.json`
keep only macOS arm64 and Linux amd64. A new target gets its own the same way.

## Setup

Use an Apple Silicon Mac (or Linux, [below](#publishing-from-linux)) with Bun, the [pinned Zig toolchain](../AGENTS.md#zig-toolchain),
Xcode's SDK and a persistent macOS signing identity. Keep signing keys and storage
credentials outside the repository. Use one publishing host at a time.

Create and back up the release signing key:

```sh
./scripts/release --init-key "$HOME/.config/corgi/release-key.pem"
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
debug symbols. Configuration fields live in [scripts/release.ts](../scripts/release.ts).

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

1. Commit the changes to ship. Review compatibility changes using
   [HACKING.md](../HACKING.md).
2. Check the selected commit and output paths with `./publish.sh --dry-run`.
3. Run `./publish.sh`. It tests, builds, signs and verifies the public downloads
   before advancing the stable channel. Wait for the final `Published Corgi` message.
4. From an installed copy, run `corgi update --check` to confirm the offered release.

Versions are immutable; never reuse a version for different bytes or casually
replace the signing key trusted by existing installations. Published versions
remain available for existing installers and rollback.

Local binaries and debug symbols stay under `.git/corgi-releases/` (the common
Git directory for linked worktrees). Keep the symbols needed for crash diagnosis.
For build-only and retry options, use `./publish.sh --help`.
