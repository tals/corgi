import type { FileSink, Subprocess } from "bun";
import * as os from "./os";
import * as ssh from "./ssh";
import * as build from "./machine_build";
import * as transfer from "./machine_transfer";
import * as transferFile from "./machine_transfer_file";
import * as progress from "./machine_progress";
import * as machines from "./machines";

/** How long a setup step may take. */
export const step_ms = 180_000;
/** An install waits for an update check and for the daemon to reload. */
export const install_ms = 600_000;
/** A build copy takes as long as the link needs, but not this long without
 * moving a byte, as when the other end's disk hangs. */
export const stalled_ms = 120_000;
/** How long a step may take in all, or, for a copy, without progress. */
export type Limit = { total: number } | { idle: number };
/** Writes `input` to a command as it takes it, saying so after each piece. */
async function feed(
  sink: FileSink,
  input: Uint8Array,
  moved: () => void,
  uploaded?: (bytes: number) => void,
  beforeFinish?: () => void,
): Promise<void> {
  let bytes = 0;
  for (let offset = 0; offset < input.byteLength; offset += 65536) {
    const chunk = input.subarray(offset, offset + 65536);
    if (offset + chunk.length === input.length) beforeFinish?.();
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
  input?: Uint8Array,
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
export function executeRemote(
  host: string,
  script: string,
  input?: Uint8Array,
  fresh = false,
  limit: Limit = { total: step_ms },
  uploaded?: (bytes: number) => void,
  signal?: AbortSignal,
) {
  return run(["ssh", ...ssh.args(host, ssh.canPrompt(), fresh), ssh.shell(script)], input, limit, uploaded, signal);
}
function transport(child: Subprocess<"pipe", "pipe", "inherit">, moved: () => void): transfer.Transport {
  const preamble = new ssh.Preamble(ssh.deltaMarker);
  return {
    readable: child.stdout.pipeThrough(
      new TransformStream({
        transform(bytes, controller) {
          moved();
          const payload = preamble.read(bytes);
          if (payload?.length) controller.enqueue(payload);
        },
        flush(controller) {
          const error = preamble.endError();
          if (error) controller.error(error);
        },
      }),
    ),
    writable: new WritableStream({
      async write(bytes) {
        child.stdin.write(bytes);
        await child.stdin.flush();
        moved();
      },
      abort() {
        child.kill("SIGKILL");
      },
    }),
  };
}
export function deltaProgress(status: progress.Progress): transfer.Progress {
  return (stage, sent, total) => {
    switch (stage) {
      case "signature":
        return status.show("Preparing delta", "Reading block signatures from the installed executable");
      case "prepare":
        return status.show("Compressing delta", "Encoding and compressing changed blocks");
      case "upload":
        return status.uploaded(sent, total, "delta");
    }
  };
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
      transport(child, timer.moved),
      typeof file === "string" ? transferFile.input(file) : file,
      hash,
      report,
      { signal },
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

/** The installed receiver speaks its existing delta protocol. The candidate owns the
 * install, so even a first install can return the verified daemon and bridge paths. */
export async function installDev(
  host: string,
  executable: string,
  installed: build.Build | null,
  socket: string,
  data: Buffer,
  hash: string,
  status: progress.Progress,
  signal?: AbortSignal,
): Promise<machines.Info> {
  const quote = os.shellQuote;
  const dest = quote(executable);
  const targetSocket = socket || installed?.socket;
  const delta = !!installed?.delta_transfer;
  const script = `set -eu
unset CORGI_MACHINE CORGI_PANE CORGI_VIEWER
${targetSocket ? "export CORGI_SOCKET=" + quote(targetSocket) : ""}
umask 077
stage=$(mktemp -d "$HOME/.corgi-setup.XXXXXXXX")
trap 'rm -f "$stage/corgi"; rmdir "$stage"' 0
trap 'exit 1' HUP INT TERM
checksum() {
  if command -v sha256sum >/dev/null; then sum=$(sha256sum < "$1"); else sum=$(shasum -a 256 < "$1"); fi
  printf '%s\\n' "\${sum%% *}"
}
basis=${installed && !installed.build_id ? `$(checksum ${dest})` : quote(installed?.build_id ?? "")}
printf '\\n%s\\n' ${quote(ssh.deltaMarker)}
${delta ? `${dest} __machine-receive "$stage/corgi" "$basis" ${quote(hash)}\ncat >/dev/null` : 'cat > "$stage/corgi"'}
[ "$(checksum "$stage/corgi")" = ${quote(hash)} ] || exit 1
chmod 700 "$stage/corgi"
"$stage/corgi" __machine-install-session ${dest} "$basis" ${quote(hash)} ${quote(build.revision)}`;
  signal?.throwIfAborted();
  const child = Bun.spawn(["ssh", ...ssh.args(host, ssh.canPrompt()), ssh.shell(script)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  let timer = deadline(child, { idle: stalled_ms });
  let installing = false;
  const commit = () => {
    // The complete candidate can be installed when stdin closes, including on disconnect.
    signal?.throwIfAborted();
    installing = true;
    signal?.removeEventListener("abort", abort);
  };
  try {
    const io = transport(child, () => timer.moved());
    if (delta) {
      const result = await transfer.send(io, data, hash, deltaProgress(status), { signal, beforeFinish: commit });
      process.stderr.write(
        `Uploaded ${progress.size(result.sent_bytes)}; received ${progress.size(result.received_bytes)} of signatures.\n`,
      );
      // The remote shell waits for EOF before writing anything after the receiver's binary acknowledgement.
      await child.stdin.end();
    } else {
      status.uploaded(0, data.length, "full");
      await feed(
        child.stdin,
        data,
        () => timer.moved(),
        bytes => status.uploaded(bytes, data.length, "full"),
        commit,
      );
    }
    timer.clear();
    timer = deadline(child, { total: install_ms });
    status.show("Installing", "Installing the executable and handing off the running daemon");
    let response = Buffer.alloc(0);
    let verifying = false;
    for await (const bytes of io.readable) {
      if (response.length + bytes.length > 65536) throw Error("SetupOutputTooLarge");
      response = Buffer.concat([response, bytes]);
      if (!verifying && response.includes(10)) {
        const end = response.indexOf(10);
        if (response.toString("utf8", 0, end) !== "verifying") throw Error("InvalidSetupResponse");
        verifying = true;
        status.show("Verifying", "Checking the installed executable’s SHA-256 and the running daemon");
        response = response.subarray(end + 1);
      }
    }
    if (await child.exited) throw Error("MachineSetupCommandFailed");
    const result = JSON.parse(response.toString());
    if (!verifying || result?.build_id !== hash) throw Error("RemoteUpgradeVerificationFailed");
    return machines.info(result.info, socket);
  } catch (error) {
    if (!installing) signal?.throwIfAborted();
    if (timer.expired) throw Error("MachineSetupTimedOut");
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    timer.clear();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
