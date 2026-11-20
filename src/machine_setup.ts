import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import * as build from "./machine_build";
import * as buildId from "./build_id";
import * as updates from "./updates";
import * as ssh from "./ssh";
import * as os from "./os";
import * as transfer from "./machine_transfer";
import * as transferFile from "./machine_transfer_file";
import * as progress from "./machine_progress";
import * as dev from "./machine_deploy";
import type { FileSink, Subprocess } from "bun";

const quote = os.shellQuote;
/** How long a setup step may take. */
const step_ms = 180_000;
/** An install waits for an update check and for the daemon to reload. */
const install_ms = 600_000;
/** A build copy takes as long as the link needs, but not this long without
 * moving a byte, as when the other end's disk hangs. */
const stalled_ms = 120_000;
/** How long a step may take in all, or, for a copy, without progress. */
type Limit = { total: number } | { idle: number };
/** Writes `input` to a command as it takes it, saying so after each piece. */
async function feed(sink: FileSink, input: Blob, moved: () => void, uploaded?: (bytes: number) => void): Promise<void> {
  let bytes = 0;
  for await (const chunk of input.stream()) {
    sink.write(chunk);
    await sink.flush();
    moved();
    bytes += chunk.byteLength;
    uploaded?.(bytes);
  }
  await sink.end();
}
/** Kills `child` past `limit`; progress puts off an idle limit. */
function deadline(child: Pick<Subprocess, "kill">, limit: Limit) {
  let timer: ReturnType<typeof setTimeout> | undefined,
    expired = false;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, ms);
  };
  arm("idle" in limit ? limit.idle : limit.total);
  return {
    moved: () => {
      if ("idle" in limit) arm(limit.idle);
    },
    get expired() {
      return expired;
    },
    clear: () => clearTimeout(timer),
  };
}
export async function run(
  command: string[],
  input?: Blob,
  limit: Limit = { total: step_ms },
  uploaded?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const child = Bun.spawn(command, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "inherit", signal });
  const timer = deadline(child, limit);
  // A command that stops reading fails on its own; its exit says so.
  if (input) void feed(child.stdin as FileSink, input, timer.moved, uploaded).catch(() => {});
  try {
    let output = "";
    for await (const chunk of child.stdout) {
      timer.moved();
      output += Buffer.from(chunk).toString();
      if (Buffer.byteLength(output) > 128 * 1024) {
        child.kill("SIGKILL");
        throw Error("SetupOutputTooLarge");
      }
    }
    const code = await child.exited;
    signal?.throwIfAborted();
    if (timer.expired) throw Error("MachineSetupTimedOut");
    if (code) throw Error("MachineSetupCommandFailed");
    return output;
  } finally {
    timer.clear();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
function executeRemote(
  host: string,
  script: string,
  input?: Blob,
  fresh = false,
  limit: Limit = { total: step_ms },
  uploaded?: (bytes: number) => void,
  signal?: AbortSignal,
) {
  return run(
    ["ssh", ...ssh.args(host, !process.env.CORGI_MACHINE_SYNC, fresh), ssh.shell(script)],
    input,
    limit,
    uploaded,
    signal,
  );
}
export async function sendDelta(
  command: string[],
  file: string | Buffer,
  hash: string,
  report: transfer.Progress,
  idle = stalled_ms,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "inherit", signal });
  const timer = deadline(child, { idle });
  try {
    const result = await transfer.send(
      {
        readable: child.stdout.pipeThrough(
          new TransformStream({
            transform(bytes, controller) {
              timer.moved();
              controller.enqueue(bytes);
            },
          }),
        ),
        writable: new WritableStream({
          async write(bytes) {
            child.stdin.write(bytes);
            await child.stdin.flush();
            timer.moved();
          },
          abort() {
            child.kill("SIGKILL");
          },
        }),
      },
      typeof file === "string" ? transferFile.input(file) : file,
      hash,
      report,
    );
    await child.stdin.end();
    if (await child.exited) throw Error("MachineTransferFailed");
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (timer.expired) throw Error("MachineSetupTimedOut");
    throw error;
  } finally {
    timer.clear();
    child.kill("SIGKILL");
    await child.exited;
  }
}
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
async function artifact(
  local: build.Build,
  wanted: build.Build,
  directory: string,
  options: Options = {},
): Promise<string> {
  if (build.released(wanted.version)) {
    const file = await updates.artifact(
      updates.release(local.executable),
      wanted.version,
      platform(wanted.target),
      directory,
    );
    const manifest = updates.parse(
      updates.release(local.executable),
      readFileSync(join(directory, "manifest.json"), "utf8"),
      platform(wanted.target),
    );
    if (manifest.commit !== wanted.commit) throw Error("WrongReleaseCommit");
    return file;
  }
  if (wanted.commit !== local.commit || wanted.source_hash !== local.source_hash)
    throw Error("DevelopmentArtifactUnavailable");
  if (wanted.target === local.target) return local.executable;
  const file = process.env.CORGI_DEV_ROOT
    ? await dev.artifact(wanted.target, options.signal, options.progress)
    : join(dirname(local.executable), `corgi-${wanted.target}`);
  if (!existsSync(file + ".build.json"))
    throw Error(`Build the matching remote artifact with bun build.ts --target ${wanted.target}`);
  const metadata = JSON.parse(readFileSync(file + ".build.json", "utf8"));
  if (
    metadata.sourceSHA256 !== local.source_hash ||
    metadata.releaseCommit !== local.commit ||
    metadata.target !== wanted.target ||
    metadata.testBuild ||
    metadata.sha256 !== createHash("sha256").update(readFileSync(file)).digest("hex")
  )
    throw Error("RemoteArtifactDoesNotMatchLocalBuild");
  return file;
}
export interface Options {
  reuseInstalledSource?: boolean;
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
): Promise<string> {
  const remote = (
    host: string,
    script: string,
    input?: Blob,
    fresh = false,
    limit: Limit = { total: step_ms },
    uploaded?: (bytes: number) => void,
  ) => executeRemote(host, script, input, fresh, limit, uploaded, options.signal);
  // A source run has no commit or artifact to compare or install.
  if (!import.meta.filename.startsWith("/$bunfs/")) throw Error("BuildCorgiBeforeMachineSetup");
  options.progress?.("Checking…", { detail: "Reading the local build identity" });
  const local = build.describe(buildId.self());
  if (deployment && build.released(local.version)) throw Error("DevelopmentBuildRequired");
  const status = new progress.Progress(options.progress);
  status.show("Checking", `Reading the installed executable on ${host}`);
  // Reconnect has already authenticated this control master, possibly with a password.
  const reuseLogin = process.env.CORGI_MACHINE_SYNC === "reconnect";
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
if [ -n "$p" ]; then "$p" __update-info; fi`,
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
  const installed = lines[3] ? build.parse(lastJSON(lines.slice(4).join("\n")), target, executable) : null;
  if (installed) {
    executable = installed.executable;
    if (!installed.socket && socket) installed.socket = socket;
  }
  // The installed build describes its source even on peers without the extended hello.
  if (
    deployment &&
    options.reuseInstalledSource &&
    installed?.build_id &&
    installed.target === target &&
    build.compare(local, installed) === "match"
  ) {
    deployment.accept(installed.build_id);
    deployment.record(installed.build_id);
    return lines[3] || executable;
  }
  const directory = mkdtempSync(join(tmpdir(), "corgi-setup-"));
  try {
    const prepared = deployment ? await artifact(local, { ...local, target }, directory, options) : "";
    const preparedData = prepared ? transferFile.input(prepared) : null;
    const preparedHash = preparedData ? createHash("sha256").update(preparedData).digest("hex") : "";
    const matches = installed && (deployment ? installed.build_id === preparedHash : build.matches(local, installed));
    if (matches) {
      if (installed.build_id) deployment?.record(installed.build_id);
      process.stderr.write(`Corgi builds match on ${host}.\n`);
      return lines[3] || executable;
    }
    deployment?.accept(installed?.build_id ?? "");
    process.stderr.write(`${installed ? "Switching to" : "Installing"} Corgi ${local.version} on ${host}…\n`);
    const file = prepared || (await artifact(local, { ...local, target }, directory, options));
    const data = preparedData ?? transferFile.input(file);
    const hash = preparedHash || createHash("sha256").update(data).digest("hex");
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
        const result = await sendDelta(
          [
            "ssh",
            ...ssh.args(host, !process.env.CORGI_MACHINE_SYNC, false, reuseLogin ? "control" : "data"),
            ssh.command(executable, ["__machine-receive", staging + "/corgi", expected, hash]),
          ],
          data,
          hash,
          (stage, sent, total) => {
            switch (stage) {
              case "signature":
                return status.show("Preparing delta", "Reading block signatures from the installed executable");
              case "prepare":
                return status.show("Compressing delta", "Encoding and compressing changed blocks");
              case "upload":
                return status.uploaded(sent, total, "delta");
            }
          },
          stalled_ms,
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
          Bun.file(file),
          false,
          { idle: stalled_ms },
          bytes => status.uploaded(bytes, data.byteLength, "full"),
        );
      }
      const manifest = join(directory, "manifest.json");
      if (existsSync(manifest)) await remote(host, `cat > ${quote(staging + "/manifest.json")}`, Bun.file(manifest));
      options.signal?.throwIfAborted();
      status.show("Installing", "Installing the executable and handing off the running daemon");
      const result = lastJSON(
        await executeRemote(
          host,
          `set -eu
if command -v sha256sum >/dev/null; then actual=$(sha256sum ${quote(staging + "/corgi")}); else actual=$(shasum -a 256 ${quote(staging + "/corgi")}); fi
[ "\${actual%% *}" = ${quote(hash)} ] || exit 1
${installed?.socket ? "CORGI_SOCKET=" + quote(installed.socket) + " " : ""}${ssh.command(staging + "/corgi", ["__machine-install", executable, expected, existsSync(manifest) ? staging + "/manifest.json" : ""])}`,
          undefined,
          false,
          { total: install_ms },
        ),
      ) as { executable: string };
      executable = result.executable;
      status.show("Verifying", "Checking the installed executable’s SHA-256");
      // Once installed, finish verification and its receipt even if the viewer detached.
      const verified = build.parse(
        lastJSON(await executeRemote(host, ssh.command(executable, ["__update-info"]))),
        target,
        executable,
      );
      if (verified.build_id !== hash) throw Error("RemoteUpgradeVerificationFailed");
      deployment?.record(hash);
      process.stderr.write(`Corgi is ready on ${host}: ${executable}.\n`);
      return executable;
    } finally {
      await executeRemote(
        host,
        `rm -f ${quote(staging + "/corgi")} ${quote(staging + "/manifest.json")}; rmdir ${quote(staging)}`,
        undefined,
        false,
        { total: 10_000 },
      ).catch(() => {});
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
