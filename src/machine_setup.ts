import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import * as build from "./machine_build";
import * as machines from "./machines";
import * as buildId from "./build_id";
import * as updates from "./updates";
import * as ssh from "./ssh";
import * as os from "./os";
import * as transferFile from "./machine_transfer_file";
import * as progress from "./machine_progress";
import * as dev from "./machine_deploy";
import * as errors from "./errors";
import * as setup_ssh from "./machine_setup_ssh";
export { run, sendDelta } from "./machine_setup_ssh";

const quote = os.shellQuote;
function lastJSON(output: string): unknown {
  return JSON.parse(output.trim().split("\n").at(-1) ?? "");
}
function platform(target: build.Target): updates.Platform {
  switch (target) {
    case "darwin-arm64":
      return "macos-aarch64";
    case "linux-arm64":
      return "linux-aarch64";
    case "linux-x64":
      return "linux-x86_64";
    default:
      throw Error("UnsupportedReleasePlatform");
  }
}
/** The signed release for `target`, for the machine to download itself. */
async function release(local: build.Build, target: build.Target, signal?: AbortSignal): Promise<setup_ssh.Release> {
  const trust = updates.release(local.executable);
  const m = await updates.published(trust, local.version, platform(target), signal);
  if (m.commit !== local.commit) throw Error("WrongReleaseCommit");
  return {
    version: local.version,
    manifest: m.bytes,
    url: m.url,
    sha256: m.sha256,
    size: m.size,
    http: trust.test_mode,
  };
}
function snapshot(file: string) {
  const stamp = dev.fileStamp(file);
  const data = transferFile.input(file);
  return { data, stamp, hash: createHash("sha256").update(data).digest("hex") };
}
async function artifact(local: build.Build, target: build.Target, directory: string, options: Options = {}) {
  if (build.released(local.version)) {
    const file = await updates.artifact(updates.release(local.executable), local.version, platform(target), directory);
    const manifest = updates.parse(
      updates.release(local.executable),
      readFileSync(join(directory, "manifest.json"), "utf8"),
      platform(target),
    );
    if (manifest.commit !== local.commit) throw Error("WrongReleaseCommit");
    return snapshot(file);
  }
  if (target === local.target) return snapshot(local.executable);
  const file = process.env.CORGI_DEV_ROOT
    ? await dev.artifact(target, options.signal, options.progress)
    : join(dirname(local.executable), `corgi-${target}`);
  if (!existsSync(file + ".build.json"))
    throw Error(`Build the matching remote artifact with bun build.ts --target ${target}`);
  const metadata = JSON.parse(readFileSync(file + ".build.json", "utf8"));
  const artifact = snapshot(file);
  if (
    !local.source_hash ||
    metadata.sourceSHA256 !== local.source_hash ||
    metadata.releaseVersion !== local.version ||
    metadata.target !== target ||
    metadata.testBuild ||
    metadata.sha256 !== artifact.hash
  )
    throw Error("RemoteArtifactDoesNotMatchLocalBuild");
  return artifact;
}
export interface Installation {
  executable: string;
  build_id?: string;
  info?: machines.Info;
  /** Setup left the machine as it was, so its saved paths stand. */
  unchanged?: boolean;
}
export interface Options {
  verifiedBuild?: (hash: string) => boolean;
  /** Only move an older release forward, as automatic updates do. */
  onlyUpgrade?: boolean;
  progress?: progress.Report;
  signal?: AbortSignal;
}
/** The viewer runs setup in a helper, so builds and checksums never block drawing. */
export async function reconcile(
  host: string,
  requested: string,
  _retryArgs: string[],
  socket = "",
  deployment?: dev.Deployment,
  options: Options = {},
): Promise<Installation> {
  const remote = (
    host: string,
    script: string,
    input?: Uint8Array,
    fresh = false,
    limit: setup_ssh.Limit = { total: setup_ssh.step_ms },
    uploaded?: (bytes: number) => void,
  ) => setup_ssh.executeRemote(host, script, input, fresh, limit, uploaded, options.signal);
  // A source run has no commit or artifact to compare or install.
  if (!import.meta.filename.startsWith("/$bunfs/")) throw Error("BuildCorgiBeforeMachineSetup");
  options.progress?.("Checking…", { detail: "Reading the local build identity" });
  // Dev setup hashes the immutable snapshot for the target, which may be a
  // cross-build. A release is named by its version.
  const local = build.describe(buildId.self(), { hash: !deployment && !build.released(build.viewer.version) });
  if (deployment && build.released(local.version)) throw Error("DevelopmentBuildRequired");
  const status = new progress.Progress(options.progress);
  status.show("Checking", `Reading the installed executable on ${host}`);
  // The viewer or a foreground command can already have authenticated the control master.
  const reuseLogin = !!process.env.CORGI_MACHINE_SYNC;
  const launcherRoot = "s/^root='\\(.*\\)'$/\\1/p";
  const output = await remote(
    host,
    `set -eu
${socket ? "export CORGI_SOCKET=" + quote(socket) : ""}
printf '\\ncorgi-setup-v1\\n'
uname -s
uname -m
printf '%s\\n' "$HOME"
p=$(command -v ${quote(requested)} || true)
if [ -z "$p" ] && [ ${quote(requested)} = corgi ] && [ -x "$HOME/.local/bin/corgi" ]; then p="$HOME/.local/bin/corgi"; fi
if [ -n "$p" ] && [ "$(head -c 9 "$p")" = '#!/bin/sh' ]; then
  root=$(sed -n ${quote(launcherRoot)} "$p")
  if [ -n "$root" ] && grep -F 'exec "$root/releases/$v/corgi" "$@"' "$p" >/dev/null; then
    v=$(cat "$root/current")
    case "$v" in ''|*[!0-9.a-fTZ-]*) exit 1;; esac
    p="$root/releases/$v/corgi"
  fi
fi
if [ -n "$p" ] && [ "$(basename "$(dirname "$(dirname "$p")")")" = releases ]; then
  root=$(dirname "$(dirname "$(dirname "$p")")")
  v=$(cat "$root/current")
  case "$v" in ''|*[!0-9.a-fTZ-]*) exit 1;; esac
  p="$root/releases/$v/corgi"
fi
printf '%s\\n' "$p"
if [ -n "$p" ]; then ${deployment || options.onlyUpgrade ? "CORGI_MACHINE_PROBE=1 " : ""}"$p" __update-info; fi`,
    undefined,
    !reuseLogin,
  );
  const marker = output.indexOf("\ncorgi-setup-v1\n");
  if (marker < 0) throw Error("InvalidSetupResponse");
  const lines = output.slice(marker + "\ncorgi-setup-v1\n".length).split("\n");
  const target = build.target(
    `${lines[0] === "Darwin" ? "darwin" : lines[0] === "Linux" ? "linux" : "unsupported"}-${["arm64", "aarch64"].includes(lines[1]) ? "arm64" : lines[1] === "x86_64" ? "x64" : "unsupported"}`,
  );
  const home = lines[2];
  if (!home.startsWith("/") || /[\x00-\x1f\x7f]/.test(home)) throw Error("InvalidRemoteHome");
  if (!lines[3] && requested !== "corgi" && !requested.startsWith("/")) throw Error("AbsoluteInstallPathRequired");
  let executable = lines[3] || (requested === "corgi" ? join(home, ".local/bin/corgi") : requested);
  const probe = lines[3] ? lastJSON(lines.slice(4).join("\n")) : null;
  const installed = lines[3] ? build.parse(probe, target, executable) : null;
  function matching(build_id?: string): Installation {
    const machine = deployment && probe && typeof probe === "object" && "machine" in probe ? probe.machine : null;
    return { executable: lines[3] || executable, build_id, info: machine ? machines.info(machine, socket) : undefined };
  }
  if (installed) {
    executable = installed.executable;
    if (!installed.socket && socket) installed.socket = socket;
  }
  if (dev.skipUpdates()) {
    if (!installed) throw Error(`Corgi is missing on ${host}; --no-remote-update skips installation.`);
    return { executable: lines[3] || executable };
  }
  // Older peers can confirm a previously verified build during setup.
  if (
    installed?.build_id &&
    installed.target === target &&
    build.compare(local, installed) === "match" &&
    options.verifiedBuild?.(installed.build_id)
  ) {
    return matching(installed.build_id);
  }
  if (options.onlyUpgrade && !(installed?.automatic && build.upgrades(local, installed))) {
    // Another runtime may have moved the installation past the one on this socket.
    const running = !!probe && typeof probe === "object" && "machine" in probe;
    if (installed && !running && build.matches(local, installed)) return matching(installed.build_id);
    return { executable: lines[3] || executable, unchanged: true };
  }
  const directory = mkdtempSync(join(tmpdir(), "corgi-setup-"));
  try {
    const prepared = deployment ? await artifact(local, target, directory, options) : null;
    if (installed && (prepared ? installed.build_id === prepared.hash : build.matches(local, installed))) {
      if (prepared) deployment?.record({ hash: prepared.hash, target, stamp: prepared.stamp });
      process.stderr.write(`Corgi builds match on ${host}.\n`);
      return matching(prepared?.hash);
    }
    process.stderr.write(`${installed ? "Switching to" : "Installing"} Corgi ${local.version} on ${host}…\n`);
    if (!deployment && build.released(local.version)) {
      try {
        const signed = await release(local, target, options.signal);
        const info = await setup_ssh.installRelease(
          host,
          executable,
          installed,
          socket,
          signed,
          status,
          options.signal,
        );
        process.stderr.write(`Corgi is ready on ${host}: ${info.executable}.\n`);
        return { executable: info.executable, build_id: signed.sha256, info };
      } catch (error) {
        if (!errors.is(error, "RemoteDownloadFailed")) throw error;
        status.show("Downloading here", `${host} couldn't download Corgi ${local.version}`);
      }
    }
    const { data, hash, stamp } = prepared ?? (await artifact(local, target, directory, options));
    if (deployment) {
      const info = await setup_ssh.installDev(host, executable, installed, socket, data, hash, status, options.signal);
      deployment.record({ hash, target, stamp });
      process.stderr.write(`Corgi is ready on ${host}: ${info.executable}.\n`);
      return { executable: info.executable, build_id: hash, info };
    }
    let expected = installed?.build_id ?? "";
    if (installed && !expected) {
      expected = (
        await remote(
          host,
          `set -eu; if command -v sha256sum >/dev/null; then sha256sum ${quote(executable)}; else shasum -a 256 ${quote(executable)}; fi`,
        )
      )
        .trim()
        .split(/\s+/)[0];
      if (!/^[a-f0-9]{64}$/.test(expected)) throw Error("InvalidRemoteBuildHash");
    }
    const staging = (await remote(host, `set -eu; umask 077; mktemp -d "$HOME/.corgi-setup.XXXXXXXX"`))
      .trim()
      .split("\n")
      .at(-1)!;
    if (!staging.startsWith(home + "/.corgi-setup.") || /[\x00-\x1f\x7f]/.test(staging))
      throw Error("InvalidRemoteStagingPath");
    try {
      if (installed?.delta_transfer && expected) {
        const result = await setup_ssh.sendDelta(
          [
            "ssh",
            ...ssh.args(host, ssh.canPrompt()),
            ssh.command(executable, ["__machine-receive", staging + "/corgi", expected, hash], ssh.deltaMarker),
          ],
          data,
          hash,
          setup_ssh.deltaProgress(status),
          setup_ssh.stalled_ms,
          options.signal,
        );
        process.stderr.write(
          `Uploaded ${progress.size(result.sent_bytes)}; received ${progress.size(result.received_bytes)} of signatures.\n`,
        );
      } else {
        status.uploaded(0, data.byteLength, "full");
        await remote(
          host,
          `set -eu; cat > ${quote(staging + "/corgi")}; chmod 700 ${quote(staging + "/corgi")}`,
          data,
          false,
          { idle: setup_ssh.stalled_ms },
          bytes => status.uploaded(bytes, data.byteLength, "full"),
        );
      }
      const manifest = join(directory, "manifest.json");
      if (existsSync(manifest))
        await remote(host, `cat > ${quote(staging + "/manifest.json")}`, readFileSync(manifest));
      options.signal?.throwIfAborted();
      status.show("Installing", "Installing the executable and handing off the running daemon");
      const install = [
        "__machine-install",
        executable,
        expected,
        existsSync(manifest) ? staging + "/manifest.json" : "",
      ];
      const result = lastJSON(
        await setup_ssh.executeRemote(
          host,
          `set -eu
if command -v sha256sum >/dev/null; then actual=$(sha256sum ${quote(staging + "/corgi")}); else actual=$(shasum -a 256 ${quote(staging + "/corgi")}); fi
[ "\${actual%% *}" = ${quote(hash)} ] || exit 1
${installed?.socket ? "CORGI_SOCKET=" + quote(installed.socket) + " " : ""}${ssh.command(staging + "/corgi", install)}`,
          undefined,
          false,
          { total: setup_ssh.install_ms },
        ),
      ) as { executable: string };
      executable = result.executable;
      status.show("Verifying", "Checking the installed executable’s SHA-256");
      const verified = build.parse(
        lastJSON(await setup_ssh.executeRemote(host, ssh.command(executable, ["__update-info"]))),
        target,
        executable,
      );
      if (verified.build_id !== hash) throw Error("RemoteUpgradeVerificationFailed");
      process.stderr.write(`Corgi is ready on ${host}: ${executable}.\n`);
      return { executable };
    } finally {
      await setup_ssh
        .executeRemote(
          host,
          `rm -f ${quote(staging + "/corgi")} ${quote(staging + "/manifest.json")}; rmdir ${quote(staging)}`,
          undefined,
          false,
          { total: 10_000 },
        )
        .catch(() => {});
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
