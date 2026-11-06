import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import * as preferences from "./preferences";
import * as os from "./os";

/** A private namespace keeps Corgi independent of a user-owned SSH master. */
function sharing(host: string, fresh: boolean): string[] {
  if (!host || host.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(host)) throw Error("InvalidSshTarget");
  if (fresh) return ["-S", "none", "-o", "ControlMaster=no"];
  const directory = `/tmp/corgi-mux-${process.getuid?.() ?? "user"}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  os.privateDirectory(directory);
  const key = createHash("sha256")
    .update(dirname(preferences.path()))
    .update("\0")
    .update(host)
    .digest("hex")
    .slice(0, 20);
  return ["-S", `${directory}/${key}-%C`, "-o", "ControlMaster=auto", "-o", "ControlPersist=600"];
}

/** OpenSSH owns authentication and encryption. A background connection cannot prompt or trust a new host. */
export function args(host: string, interactive: boolean, fresh = false): string[] {
  return [
    ...sharing(host, fresh),
    "-T",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "ForkAfterAuthentication=no",
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
export function command(executable: string, args: string[]): string {
  if (!executable || /[\x00-\x1f\x7f]/.test(executable)) throw Error("InvalidRemoteExecutable");
  const script =
    "exec env -u CORGI_MACHINE -u CORGI_PANE -u CORGI_VIEWER " + [executable, ...args].map(os.shellQuote).join(" ");
  return shell(script);
}

/** Double quoting survives both POSIX login shells and fish before sh parses the script. */
export function shell(script: string): string {
  return 'sh -c "' + script.replace(/[\\$"`]/g, "\\$&") + '"';
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
