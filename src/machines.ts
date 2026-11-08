import * as ssh from "./ssh";
import { Remote, startup_ms } from "./daemon_transport";
import * as preferences from "./preferences";
import { readFileSync, existsSync, openSync, closeSync, statSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as os from "./os";
import * as json from "./json";
import * as protocol from "./protocol";
import * as errors from "./errors";
import { flock } from "./native_bridge";
import { Connection } from "./rpc";
import * as imageUpload from "./image_upload";

export interface Profile {
  name: string;
  target: string;
  executable: string;
  socket: string;
  home: string;
  bridge?: string;
}
export interface Info {
  remote_protocol: number;
  protocol: number;
  viewer_protocol: number;
  executable: string;
  socket: string;
  home: string;
  bridge?: string;
}
export const remote_protocol = 1;
export const catalogPath = () => join(dirname(preferences.path()), "remote/machines.json");
export function name(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(value) || value === "local") throw Error("InvalidMachineName");
  return value;
}
export function target(value: string): string {
  if (!value || value.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(value)) throw Error("InvalidSshTarget");
  return value;
}
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
    throw Error("InvalidRemotePath");
  return value;
}
export function info(value: unknown): Info {
  if (!value || typeof value !== "object") throw Error("InvalidRemoteInfo");
  const v = value as Record<string, unknown>;
  if (
    v.remote_protocol !== remote_protocol ||
    v.protocol !== protocol.version ||
    v.viewer_protocol !== protocol.viewer_version
  )
    throw Error("IncompatibleRemoteCorgi");
  const socket = path(v.socket);
  if (socket.includes(":")) throw Error("InvalidRemoteSocket");
  return {
    remote_protocol,
    protocol: protocol.version,
    viewer_protocol: protocol.viewer_version,
    executable: path(v.executable),
    socket,
    home: path(v.home),
    ...(v.bridge === undefined ? {} : { bridge: path(v.bridge) }),
  };
}
export function read(file = catalogPath()): Profile[] {
  if (!existsSync(file)) return [];
  const v: unknown = json.parse(readFileSync(file, "utf8"));
  if (
    !v ||
    typeof v !== "object" ||
    !("version" in v) ||
    v.version !== 1 ||
    !("machines" in v) ||
    !Array.isArray(v.machines)
  )
    throw Error("InvalidMachineCatalog");
  const names = new Set<string>();
  return v.machines.map((row: unknown) => {
    if (!row || typeof row !== "object") throw Error("InvalidMachineCatalog");
    const p = row as Record<string, unknown>;
    if (typeof p.name !== "string" || typeof p.target !== "string") throw Error("InvalidMachineCatalog");
    const profile = {
      name: name(p.name),
      target: target(p.target),
      executable: path(p.executable),
      socket: path(p.socket),
      home: path(p.home),
      ...(p.bridge === undefined ? {} : { bridge: path(p.bridge) }),
    };
    if (names.has(profile.name) || profile.socket.includes(":")) throw Error("InvalidMachineCatalog");
    names.add(profile.name);
    return profile;
  });
}
export function find(value: string): Profile {
  const profile = read().find(p => p.name === value);
  if (!profile) throw Error("UnknownMachine");
  return profile;
}
export async function edit(change: (profiles: Profile[]) => Profile[], file = catalogPath()): Promise<void> {
  os.privateDirectory(dirname(file));
  const fd = openSync(file + ".lock", "a", 0o600);
  try {
    const until = Date.now() + 5000;
    while (!flock(fd)) {
      if (Date.now() >= until) throw Error("MachineCatalogBusy");
      await Bun.sleep(20);
    }
    os.atomicWrite(file, json.stringify({ version: 1, machines: change(read(file)) }) + "\n");
  } finally {
    flock(fd, false);
    closeSync(fd);
  }
}
export async function discover(host: string, executable = "corgi", socket = ""): Promise<Info> {
  const child = spawn(
    "ssh",
    [
      ...ssh.args(host, true),
      socket
        ? ssh.command("env", [`CORGI_SOCKET=${socket}`, executable, "__remote-info"])
        : ssh.command(executable, ["__remote-info"]),
    ],
    {
      stdio: ["inherit", "pipe", "inherit"],
    },
  );
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 65536) child.kill();
  });
  const code = await exited(child, 120_000);
  if (code !== 0) throw Error("RemoteDiscoveryFailed");
  // A shell's startup banner is not part of the protocol.
  const line = output.trim().split("\n").at(-1) ?? "";
  return info(json.parse(line));
}
export async function execute(profile: Profile, args: string[]): Promise<number> {
  const child = spawn(
    "ssh",
    [...ssh.args(profile.target, true), ssh.command(profile.executable, ["__remote-run", profile.socket, ...args])],
    { stdio: "inherit" },
  );
  return exited(child);
}
export async function image(
  profile: Profile,
  source: string,
  mime: string,
  instance: string,
  signal: AbortSignal,
  progress?: imageUpload.Progress,
): Promise<string> {
  if (statSync(source).size > imageUpload.max_bytes) throw Error("StreamTooLong");
  const bytes = readFileSync(source);
  if (bytes.length > imageUpload.max_bytes) throw Error("StreamTooLong");
  const child = spawn(
    "ssh",
    [
      ...ssh.args(profile.target, false, true),
      ssh.command(profile.executable, ["__remote-image", profile.socket, instance, mime]),
    ],
    { stdio: ["pipe", "pipe", "pipe"], signal },
  );
  const receipts = new imageUpload.Receipts(bytes.length, progress);
  let failure: unknown;
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    try {
      receipts.feed(chunk);
    } catch (error) {
      failure = error;
      child.kill();
    }
  });
  child.stderr!.resume();
  child.stdin!.on("error", () => {});
  child.stdin!.end(bytes);
  const code = await exited(child, 30_000);
  if (failure) throw failure;
  if (code !== 0) throw Error("ImageUploadFailed");
  return receipts.finish();
}
function exited(child: ChildProcess, timeout?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer =
      timeout === undefined
        ? null
        : setTimeout(() => {
            child.kill();
            reject(Error("RemoteTimedOut"));
          }, timeout);
    const done = () => {
      if (timer) clearTimeout(timer);
    };
    child.once("error", error => {
      done();
      reject(error);
    });
    // The final path and receipts can still be buffered when the process exits.
    child.once("close", code => {
      done();
      resolve(code ?? 1);
    });
  });
}
export function compatible(hello: protocol.Reply<"hello">): string {
  if (hello.protocol !== protocol.version || hello.viewer_protocol !== protocol.viewer_version || !hello.instance)
    throw Error("IncompatibleRemoteCorgi");
  return hello.instance;
}
export async function listing(profile: Profile | null, local: string): Promise<unknown> {
  const tunnel = profile ? new Remote(profile) : null;
  let conn: Connection | null = null;
  try {
    if (tunnel) await tunnel.open();
    let established = !profile;
    conn = new Connection(tunnel?.socket ?? local, { timeout_ms: () => (established ? 10_000 : startup_ms) });
    if (profile) compatible(await conn.call("hello"));
    established = true;
    const result = await conn.call("session.list");
    return { machine: profile?.name ?? "local", ...result };
  } catch (error) {
    return { machine: profile?.name ?? "local", ok: false, err: errors.name(error) ?? "ConnectionFailed" };
  } finally {
    conn?.close();
    tunnel?.close();
  }
}
