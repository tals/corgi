import { mkdtempSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import * as build from "./machine_build";
import * as buildId from "./build_id";
import * as updates from "./updates";
import * as ssh from "./ssh";
import * as os from "./os";

const quote = os.shellQuote;
async function run(command: string[], input?: Blob, limit = 180_000): Promise<string> {
  const child = Bun.spawn(command, { stdin: input ?? "ignore", stdout: "pipe", stderr: "inherit" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, limit);
  try {
    let output = "";
    for await (const chunk of child.stdout) {
      output += Buffer.from(chunk).toString();
      if (Buffer.byteLength(output) > 128 * 1024) {
        child.kill("SIGKILL");
        throw Error("SetupOutputTooLarge");
      }
    }
    const code = await child.exited;
    if (timedOut) throw Error("MachineSetupTimedOut");
    if (code) throw Error("MachineSetupCommandFailed");
    return output;
  } finally {
    clearTimeout(timer);
  }
}
function remote(host: string, script: string, input?: Blob, fresh = false) {
  return run(["ssh", ...ssh.args(host, true, fresh), ssh.shell(script)], input);
}
function lastJSON(output: string): unknown {
  return JSON.parse(output.trim().split("\n").at(-1) ?? "");
}
async function ancestor(older: string, newer: string): Promise<boolean> {
  const child = Bun.spawn(["git", "merge-base", "--is-ancestor", older, newer], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await child.exited) === 0;
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
async function artifact(local: build.Build, wanted: build.Build, directory: string): Promise<string> {
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
  if (!import.meta.filename.startsWith("/$bunfs/")) throw Error("BuildCorgiBeforeMachineSetup");
  if (wanted.target === local.target) return local.executable;
  const file = join(dirname(local.executable), `corgi-${wanted.target}`);
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
/** Setup owns upgrades; the viewer's reconnect loop never waits for installation. */
export async function reconcile(host: string, requested: string, retryArgs: string[], socket = ""): Promise<string> {
  const local = build.describe(buildId.self());
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
    true,
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
  const order = installed ? await build.compare(local, installed, ancestor) : 1;
  if (!order) {
    process.stderr.write(`Corgi builds match on ${host}.\n`);
    return lines[3] || executable;
  }
  const directory = mkdtempSync(join(tmpdir(), "corgi-setup-"));
  try {
    if (order < 0) {
      process.stderr.write(`Remote Corgi ${installed!.version} is newer; upgrading this installation first…\n`);
      let file: string;
      if (!build.released(installed!.version) && installed!.target === local.target && installed!.build_id) {
        file = join(directory, "corgi");
        const child = Bun.spawn(["ssh", ...ssh.args(host, true, true), "cat " + quote(installed!.executable)], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
        const writer = Bun.file(file).writer();
        let size = 0;
        try {
          for await (const chunk of child.stdout) {
            size += chunk.length;
            if (size > 256 * 1024 * 1024) throw Error("ArtifactTooLarge");
            writer.write(chunk);
          }
          await writer.end();
          if (await child.exited) throw Error("ArtifactDownloadFailed");
        } finally {
          clearTimeout(timer);
          child.kill();
          await writer.end();
        }
        if (createHash("sha256").update(readFileSync(file)).digest("hex") !== installed!.build_id)
          throw Error("ArtifactHashMismatch");
        chmodSync(file, 0o700);
      } else file = await artifact(local, { ...installed!, target: local.target }, directory);
      const result = lastJSON(
        await run([
          file,
          "__machine-install",
          local.executable,
          local.build_id,
          existsSync(join(directory, "manifest.json")) ? join(directory, "manifest.json") : "",
        ]),
      ) as { executable: string };
      rmSync(directory, { recursive: true, force: true });
      process.execve!(result.executable, [result.executable, "machine", ...retryArgs], process.env);
      throw Error("LocalUpgradeExecFailed");
    }
    process.stderr.write(`${installed ? "Upgrading" : "Installing"} Corgi ${local.version} on ${host}…\n`);
    const file = await artifact(local, { ...local, target }, directory);
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
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
      await remote(
        host,
        `set -eu; cat > ${quote(staging + "/corgi")}; chmod 700 ${quote(staging + "/corgi")}`,
        Bun.file(file),
      );
      const manifest = join(directory, "manifest.json");
      if (existsSync(manifest)) await remote(host, `cat > ${quote(staging + "/manifest.json")}`, Bun.file(manifest));
      const result = lastJSON(
        await remote(
          host,
          `set -eu
if command -v sha256sum >/dev/null; then actual=$(sha256sum ${quote(staging + "/corgi")}); else actual=$(shasum -a 256 ${quote(staging + "/corgi")}); fi
[ "\${actual%% *}" = ${quote(hash)} ] || exit 1
${installed?.socket ? "CORGI_SOCKET=" + quote(installed.socket) + " " : ""}${ssh.command(staging + "/corgi", ["__machine-install", executable, expected, existsSync(manifest) ? staging + "/manifest.json" : ""])}`,
        ),
      ) as { executable: string };
      executable = result.executable;
      const verified = build.parse(
        lastJSON(await remote(host, ssh.command(executable, ["__update-info"]))),
        target,
        executable,
      );
      if (verified.build_id !== hash) throw Error("RemoteUpgradeVerificationFailed");
      process.stderr.write(`Corgi is ready on ${host}: ${executable}.\n`);
      return executable;
    } finally {
      await remote(
        host,
        `rm -f ${quote(staging + "/corgi")} ${quote(staging + "/manifest.json")}; rmdir ${quote(staging)}`,
      ).catch(() => {});
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
