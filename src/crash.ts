import { dlopen, suffix } from "bun:ffi";
import { mkdirSync, chmodSync, writeFileSync, readFileSync, readdirSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { nativeRoot } from "./native_paths";
import * as config from "./build_config";
export type Process = "daemon" | "viewer";
export class Endpoint {
  constructor(
    readonly url: string,
    readonly proto: string,
    readonly auth: string,
  ) {}
  static parse(dsn: string, version = config.releaseVersion): Endpoint {
    const url = new URL(dsn),
      slash = url.pathname.lastIndexOf("/");
    if (!["http:", "https:"].includes(url.protocol) || !url.username || slash < 0 || slash === url.pathname.length - 1)
      throw Error("InvalidSentryDSN");
    return new Endpoint(
      `${url.protocol}//${url.host}${url.pathname.slice(0, slash)}/api/${url.pathname.slice(slash + 1)}/envelope/`,
      "=" + url.protocol.slice(0, -1),
      `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=${decodeURIComponent(url.username)}, sentry_client=corgi/${version}`,
    );
  }
}
const crashSymbols = {
  app_crash_init: { args: ["cstring", "cstring", "cstring", "cstring"], returns: "i32" },
  app_crash_close: { args: [], returns: "void" },
} as const;
let native: ReturnType<typeof dlopen<typeof crashSymbols>> | null = null,
  database = "",
  dsn = "",
  role: Process = "daemon",
  release = "",
  initialized = false,
  uploading = false;
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== (process.getuid?.() ?? stat.uid)) throw Error("UnsafeDirectory");
  chmodSync(path, 0o700);
}
export function init(processRole: Process, options: { dsn?: string; database?: string; version?: string } = {}): void {
  if (initialized) return;
  dsn = options.dsn ?? config.sentryDSN;
  if (!dsn) return;
  Endpoint.parse(dsn);
  database =
    options.database ??
    join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/", ".local/state"), "corgi/crash");
  privateDirectory(database);
  privateDirectory(join(database, "outbox"));
  role = processRole;
  release = options.version ?? config.releaseVersion;
  native = dlopen(`${nativeRoot}/lib/libcorgi_system.${suffix}`, crashSymbols);
  if (
    native.symbols.app_crash_init(
      Buffer.from(dsn + "\0"),
      Buffer.from(database + "\0"),
      Buffer.from("corgi@" + release + "\0"),
      Buffer.from(role + "\0"),
    )
  )
    throw Error("SentryInitFailed");
  initialized = true;
  process.on("uncaughtExceptionMonitor", notePanic);
  void uploadPending().catch(error => console.error("crash report not sent:", error));
}
export function notePanic(error: unknown): void {
  if (!initialized) return;
  try {
    const id = crypto.randomUUID().replaceAll("-", ""),
      exception = error instanceof Error ? error : new Error(String(error));
    const event = {
      event_id: id,
      timestamp: Date.now() / 1000,
      platform: "javascript",
      level: "fatal",
      release: "corgi@" + release,
      tags: { process: role },
      exception: {
        values: [
          { type: exception.name, value: exception.message, stacktrace: { frames: frames(exception.stack ?? "") } },
        ],
      },
    };
    const payload = JSON.stringify(event),
      envelope =
        JSON.stringify({ event_id: id, dsn }) +
        "\n" +
        JSON.stringify({ type: "event", length: Buffer.byteLength(payload) }) +
        "\n" +
        payload +
        "\n";
    writeFileSync(join(database, "outbox", id + ".envelope"), envelope, { flag: "wx", mode: 0o600 });
  } catch {}
}
function frames(stack: string) {
  return stack
    .split("\n")
    .slice(1, 129)
    .map(line => {
      const match = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
      return match
        ? { function: match[1] ?? "<anonymous>", filename: match[2], lineno: Number(match[3]), colno: Number(match[4]) }
        : { function: line.trim() };
    })
    .reverse();
}
export async function uploadPending(): Promise<void> {
  if (!initialized || uploading) return;
  uploading = true;
  try {
    const endpoint = Endpoint.parse(dsn, release),
      folder = join(database, "outbox");
    for (const file of readdirSync(folder, { withFileTypes: true }))
      if (file.isFile() && file.name.endsWith(".envelope")) {
        const path = join(folder, file.name),
          stat = lstatSync(path);
        if (stat.size > 16 * 1024 * 1024) continue;
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "X-Sentry-Auth": endpoint.auth.slice("X-Sentry-Auth: ".length),
            "Content-Type": "application/x-sentry-envelope",
          },
          body: readFileSync(path),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        await response.body?.cancel();
        if (!response.ok) throw Error("CrashUploadFailed");
        unlinkSync(path);
      }
  } finally {
    uploading = false;
  }
}
export function close() {
  if (!initialized) return;
  process.off("uncaughtExceptionMonitor", notePanic);
  native?.symbols.app_crash_close();
  initialized = false;
}
