import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import * as preferences from "./preferences";
import * as os from "./os";

export const bridgeMarker = "corgi-bridge-v1";
export const deltaMarker = "corgi-delta-v1";

export function canPrompt(): boolean {
  const sync = process.env.CORGI_MACHINE_SYNC;
  return !sync || sync === "interactive";
}

/** Discards shell startup output up to a line marking the start of binary stdout. */
export class Preamble {
  private pending: Buffer | null = Buffer.alloc(0);
  private readonly boundary: Buffer;
  constructor(
    marker: string,
    private readonly connected: () => void = () => {},
  ) {
    this.boundary = Buffer.from(`\n${marker}\n`);
  }
  read(chunk: Uint8Array): Uint8Array | null {
    if (this.pending === null) return chunk;
    const bytes = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const start = bytes.indexOf(this.boundary);
    const end = start < 0 ? bytes.length : start + this.boundary.length;
    if (end > 65536) throw Error("InvalidSshPreamble");
    if (start < 0) {
      this.pending = bytes;
      return null;
    }
    this.pending = null;
    this.connected();
    return bytes.subarray(end);
  }
  endError(): Error | null {
    return this.pending === null ? null : Error("MissingSshPreamble");
  }
}

/** A private namespace keeps Corgi independent of a user-owned SSH master. */
function sharing(host: string, fresh: boolean, lane: Lane): string[] {
  if (!host || host.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(host)) throw Error("InvalidSshTarget");
  if (fresh) return ["-S", "none", "-o", "ControlMaster=no"];
  const directory = `/tmp/corgi-mux-${process.getuid?.() ?? "user"}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  os.privateDirectory(directory);
  const key = createHash("sha256")
    .update(dirname(preferences.path()))
    .update("\0")
    .update(host)
    .update(lane === "control" ? "" : `-${lane}`)
    .digest("hex")
    .slice(0, 20);
  return ["-S", `${directory}/${key}-%C`, "-o", "ControlMaster=auto", "-o", "ControlPersist=600"];
}

/** Commands and the viewer's control lane share one master; pane data, which
 * Corgi compresses itself, has its own, and so do forwarded ports, so a
 * page loading can't hold up either. */
export type Lane = "control" | "data" | "forward";
/** OpenSSH owns authentication and encryption. A background connection cannot prompt or trust a new host. */
export function args(host: string, interactive: boolean, fresh = false, lane: Lane = "control"): string[] {
  return [
    ...sharing(host, fresh, lane),
    "-T",
    "-o",
    `Compression=${lane === "data" ? "no" : "yes"}`,
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    // Forwardings from the user's own SSH config, an agent socket among them,
    // would stay open for as long as the viewer runs.
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "ConnectTimeout=30",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    `BatchMode=${interactive ? "no" : "yes"}`,
    "-o",
    `StrictHostKeyChecking=${interactive ? "ask" : "yes"}`,
    "--",
    host,
  ];
}
/** No shell text supplied by a profile or a CLI argument is evaluated. */
export function command(executable: string, args: string[], marker?: string): string {
  if (!executable || /[\x00-\x1f\x7f]/.test(executable)) throw Error("InvalidRemoteExecutable");
  const script =
    "exec env -u CORGI_MACHINE -u CORGI_PANE -u CORGI_VIEWER " + [executable, ...args].map(os.shellQuote).join(" ");
  // Printing in the shell also frames executables installed by older clients.
  return shell((marker ? `printf '\\n%s\\n' ${os.shellQuote(marker)}; ` : "") + script);
}

/** Runs the machine's native bridge to `socket`. The Corgi there takes over
 * when an update or a reboot took the saved bridge away, and with `start`,
 * when the bridge finds no daemon listening (exit 3): then it starts one.
 * The bridge lives under a shared temporary folder, so it runs only from a
 * native-files folder the user there owns, as Corgi there loads them
 * (native_paths.ts). */
export function bridge(executable: string, bridge: string, socket: string, start: boolean): string {
  for (const value of [executable, bridge])
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw Error("InvalidRemoteExecutable");
  const env = "env -u CORGI_MACHINE -u CORGI_PANE -u CORGI_VIEWER ",
    // ROOT/bin/corgi-remote-bridge, with ROOT in the user's own folder.
    folder = dirname(dirname(dirname(bridge))),
    [path, owned, program, target] = [bridge, folder, executable, socket].map(os.shellQuote),
    usable = `[ -O ${owned} ] && [ ! -L ${owned} ] && [ -x ${path} ]`;
  return shell(
    start
      ? `if ${usable}; then ${env}${path} ${target}; status=$?; [ "$status" -eq 3 ] || exit "$status"; fi; ` +
          `exec ${env}${program} __remote-bridge ${target}`
      : `if ${usable}; then exec ${env}${path} ${target}; fi; exec ${env}${program} __remote-bridge --running ${target}`,
  );
}

/** Double quoting survives both POSIX login shells and fish before sh parses the script. */
export function shell(script: string): string {
  return 'sh -c "' + script.replace(/[\\$"`]/g, "\\$&") + '"';
}

/** Why OpenSSH's last complaint in its stderr says it failed, as the
 * system put it: "Connection refused" from `ssh: connect to host …: Connection refused`.
 * Each system words a failed lookup its own way. */
export function reason(message: string): string | null {
  const complaint = message
    .split("\n")
    .map(line => line.trim())
    .findLast(line => line.startsWith("ssh: "));
  if (!complaint) return null;
  if (complaint.startsWith("ssh: Could not resolve hostname")) return "Could not resolve hostname";
  return complaint.slice(complaint.lastIndexOf(": ") + 2);
}
/** Classify OpenSSH's stderr once at the transport boundary. */
export type Failure = "auth" | "host-key" | "error";
export function failure(message: string): Failure {
  if (/host key verification failed|remote host identification has changed|no .*host key is known/i.test(message))
    return "host-key";
  if (
    /permission denied \(|authentication failed|too many authentication failures|sign_and_send_pubkey: signing failed|no supported authentication methods/i.test(
      message,
    )
  )
    return "auth";
  return "error";
}

/** How far a login has got, as `ssh -v` tells it. */
export type Stage = "connecting" | "authenticating" | "running";
/** What a probe found: the system the host runs, as `uname -sm` names it,
 * or why SSH couldn't log in there. */
export type Probed = { system: string } | { failed: Failure; reason: string | null };
/** The longest a probe runs, past SSH's own connect timeout. */
const probe_ms = 45_000;
/** How long a probe still reads ssh's output once ssh has exited. A
 * connection it left in the background (a jump host's shared connection,
 * kept by ControlPersist) can hold that output open for minutes. */
const drain_ms = 250;
/** Logs in to `host` as a background connection does, without prompts,
 * and asks what system it runs; `stage` hears how far it has got. Null
 * once `signal` aborts it. */
export async function probe(host: string, stage: (stage: Stage) => void, signal: AbortSignal): Promise<Probed | null> {
  if (signal.aborted) return null;
  const child = Bun.spawn(["ssh", "-v", ...args(host, false, true), shell("uname -sm")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let expired = false;
  const stop = () => child.kill();
  const timer = setTimeout(() => {
    expired = true;
    stop();
  }, probe_ms);
  signal.addEventListener("abort", stop, { once: true });
  // What SSH said besides its debugging, for why it failed.
  let said = "",
    settled = false;
  const stderr = child.stderr.getReader(),
    stages = async () => {
      const decoder = new TextDecoder();
      let pending = "";
      for (let read = await stderr.read(); !read.done; read = await stderr.read()) {
        pending += decoder.decode(read.value, { stream: true });
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (settled) continue;
          if (line.startsWith("debug1: Connection established")) stage("authenticating");
          else if (/^Authenticated to |^debug1: Authentication succeeded/.test(line)) stage("running");
          else if (!line.startsWith("debug")) said = (said + line + "\n").slice(-8192);
        }
        if (pending.length > 65536) pending = "";
      }
    };
  const drained = <T>(reading: Promise<T>, otherwise: T) =>
    Promise.race([reading, Bun.sleep(drain_ms).then(() => otherwise)]);
  try {
    const output = new Response(child.stdout).text(),
      told = stages().catch(() => {});
    const code = await child.exited;
    const [text] = await Promise.all([drained(output, ""), drained(told, undefined)]);
    settled = true;
    void stderr.cancel().catch(() => {});
    if (signal.aborted) return null;
    if (code === 0) return { system: systemName(text) };
    return { failed: failure(said), reason: expired ? "timed out" : reason(said) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
/** `uname -sm`'s answer, past anything a login shell printed first, with
 * macOS by its own name. */
function systemName(output: string): string {
  const line = output.trim().split("\n").at(-1)?.trim() ?? "";
  return line
    .replace(/^Darwin\b/, "macOS")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 48);
}

/** The hosts an SSH config names outright, in order: each `Host` alias
 * that isn't a pattern, through its `Include`s. A block that logs in as
 * `git` is a forge's, not a machine's. */
export function configHosts(home = homedir(), file = join(home, ".ssh", "config")): string[] {
  const hosts: string[] = [];
  let block: string[] = [],
    user = "";
  const end = () => {
    if (user.toLowerCase() !== "git") for (const name of block) if (!hosts.includes(name)) hosts.push(name);
    block = [];
    user = "";
  };
  // An included file reads as if written in place, within the block it's in.
  const read = (path: string, depth: number) => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const [keyword = "", ...values] = configWords(line);
      switch (keyword.toLowerCase()) {
        case "host":
          end();
          block = values.filter(value => !/[*?!%]/.test(value));
          break;
        case "match":
          end();
          break;
        case "user":
          user ||= values[0] ?? "";
          break;
        case "include":
          // OpenSSH's own limit, which also ends a file including itself.
          if (depth < 16)
            for (const pattern of values)
              for (const found of included(pattern, home, dirname(file))) read(found, depth + 1);
      }
    }
  };
  read(file, 0);
  end();
  return hosts;
}
/** A config line's keyword and arguments, from `Key value` or `Key=value`,
 * with quoted arguments kept whole; none for a comment. */
function configWords(line: string): string[] {
  const [, keyword, rest = ""] = /^\s*([^\s=#]+)\s*=?\s*(.*)$/.exec(line) ?? [];
  if (!keyword) return [];
  const values: string[] = [];
  for (const [, quoted, bare] of rest.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (bare?.startsWith("#")) break;
    values.push(quoted ?? bare);
  }
  return [keyword, ...values];
}
/** The files an `Include` names: from `~` or the config's folder, with
 * wildcards in the file's name. */
function included(pattern: string, home: string, folder: string): string[] {
  const path = pattern.startsWith("~/")
    ? join(home, pattern.slice(2))
    : isAbsolute(pattern)
      ? pattern
      : join(folder, pattern);
  const parts = path.split("/"),
    first = parts.findIndex(part => /[*?[]/.test(part));
  if (first < 0) return [path];
  // Matched part by part, as glob(3) does, from the folder before the first wildcard.
  const glob = new Bun.Glob(parts.slice(first).join("/"));
  try {
    return [
      ...glob.scanSync({ cwd: parts.slice(0, first).join("/") || "/", absolute: true, followSymlinks: true }),
    ].sort();
  } catch {
    return [];
  }
}
