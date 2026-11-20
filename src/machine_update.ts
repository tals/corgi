import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import * as builds from "./machine_build";
import * as buildId from "./build_id";
import * as machines from "./machines";
import * as dev from "./machine_deploy";
import * as progressInfo from "./machine_progress";

type Event = ({ type: "progress" } & progressInfo.Status) | { type: "ready" } | { type: "error"; message: string };
function clean(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw Error("InvalidMachineUpdateEvent");
  return value.replace(/[\x00-\x1f\x7f]/g, " ");
}
export function event(value: unknown): Event {
  if (!value || typeof value !== "object" || !("type" in value)) throw Error("InvalidMachineUpdateEvent");
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "error":
      if ("message" in value) return { type: "error", message: clean(value.message) };
      break;
    case "progress":
      if ("message" in value)
        return {
          type: "progress",
          message: clean(value.message),
          ...("metrics" in value ? { metrics: clean(value.metrics) } : {}),
          ...("detail" in value ? { detail: clean(value.detail) } : {}),
          ...("compact" in value ? { compact: clean(value.compact) } : {}),
        };
  }
  throw Error("InvalidMachineUpdateEvent");
}
export class Failure extends Error {
  readonly reply: { err: string; detail: string };
  constructor(
    readonly detail: string,
    readonly summary: string = detail,
  ) {
    super("MachineUpdateFailed");
    this.summary = summary.replace(/[\x00-\x1f\x7f]/g, " ");
    this.reply = { err: this.message, detail };
  }
}
async function readProgress(output: AsyncIterable<Uint8Array>, progress: progressInfo.Report) {
  let result: Extract<Event, { type: "ready" | "error" }> | null = null;
  let pending = "";
  const decoder = new TextDecoder();
  for await (const bytes of output) {
    pending += decoder.decode(bytes, { stream: true });
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      if (end > 8192) throw Error("InvalidMachineUpdateEvent");
      const value = event(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
      switch (value.type) {
        case "progress":
          progress(value.message, { metrics: value.metrics, detail: value.detail, compact: value.compact });
          break;
        case "ready":
        case "error":
          result = value;
          break;
      }
    }
    if (pending.length > 8192) throw Error("InvalidMachineUpdateEvent");
  }
  return pending ? null : result;
}
export async function prepare(
  profile: machines.Profile,
  {
    progress = progressInfo.print,
    signal,
    interactive = false,
  }: {
    progress?: progressInfo.Report;
    signal?: AbortSignal;
    interactive?: boolean;
  } = {},
): Promise<machines.Profile> {
  if (!dev.enabled()) return profile;
  signal?.throwIfAborted();
  const child = spawn(
    buildId.self(),
    ["__machine-sync", profile.name, profile.target, profile.socket, builds.revision],
    {
      env: { ...process.env, CORGI_MACHINE_SYNC: interactive ? "interactive" : "1" },
      detached: !!signal,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
  });
  // An install already committing remotely must finish its receipt. It can outlive the viewer.
  const abort = () => {
    child.kill("SIGTERM");
    child.unref();
    (child.stdout as Socket).unref();
    (child.stderr as Socket).unref();
  };
  signal?.addEventListener("abort", abort, { once: true });
  let diagnostic = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    diagnostic = (diagnostic + chunk).slice(-8192);
  });
  try {
    const [code, result] = await Promise.all([exited, readProgress(child.stdout, progress)]);
    signal?.throwIfAborted();
    if (code !== 0 || result?.type !== "ready") {
      const summary = result?.type === "error" ? result.message : "Update helper stopped before finishing.";
      throw new Failure(diagnostic.trim() || summary, summary);
    }
    const refreshed = machines.find(profile.name);
    if (refreshed.target !== profile.target || refreshed.socket !== profile.socket) throw Error("MachineChanged");
    return refreshed;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGTERM");
    child.stderr.destroy();
    await exited;
  }
}
