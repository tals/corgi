import * as protocol from "./protocol";
import { basename, dirname, resolve } from "node:path";
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import * as os from "./os";
import * as rpc from "./rpc";
import * as cli from "./cli";
import * as json from "./json";
import helpText from "../assets/help.txt" with { type: "text" };
import { specs as actionSpecs } from "./action";
import type { Preset } from "./keymap";
import { flock, n } from "./native_bridge";
import * as updates from "./updates";
import { testBuild } from "./build_assets";
import * as config from "./build_config";
import * as crash from "./crash";
import * as build_id from "./build_id";
export const executable = build_id.executablePath(
  import.meta.filename,
  process.execPath,
  resolve(import.meta.dir, "../corgi"),
  process.env.CORGI_APP_EXE,
);
export const actionNames = (() => {
  const lines = ["Actions:"];
  for (const name of Object.keys(actionSpecs).filter(name => name !== "relaunch")) {
    if (Buffer.byteLength(lines.at(-1)!) + name.length + 2 > 80) lines.push("  " + name + ",");
    else lines[lines.length - 1] += " " + name + ",";
  }
  lines[lines.length - 1] = lines.at(-1)!.slice(0, -1) + ".";
  return lines.join("\n");
})();
const help = helpText.replace("\n\n\n\n", `\n\n${actionNames}\n\n`);
export const buildId = (): string => build_id.of(executable);
const provider = (value: string) => {
  if (value !== "codex" && value !== "claude") throw Error("BadProvider");
  return value;
};
export function providerAlias(argv0: string): "codex" | "claude" | null {
  const name = basename(argv0);
  return name === "codex" || name === "claude" ? name : null;
}
export function paneId(value: string): number {
  if (!/^\+?\d+$/.test(value)) throw Error("InvalidCharacter");
  const pane = Number(value);
  if (!Number.isSafeInteger(pane) || pane > 0xffffffff) throw Error("Overflow");
  return pane;
}
async function ping(path: string): Promise<boolean> {
  try {
    await rpc.request(path, "ping");
    return true;
  } catch {
    return false;
  }
}
export async function ensureServer(path: string, exe = executable): Promise<void> {
  if (await ping(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const guard = openSync(path + ".start.lock", "a", 0o600);
  try {
    while (!flock(guard)) {
      if (await ping(path)) return;
      await Bun.sleep(20);
    }
    if (await ping(path)) return;
    try {
      unlinkSync(path);
    } catch {}
    const log = dirname(path) + "/server.log",
      fd = openSync(log, "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, ["serve"], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, CORGI_APP_EXE: exe },
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    const until = Date.now() + 10000;
    while (Date.now() < until && !exited) {
      if (await ping(path)) return;
      await Bun.sleep(20);
    }
    try {
      process.stderr.write(readFileSync(log, "utf8").slice(-8192));
    } catch {}
    throw Error("ServerStartFailed");
  } finally {
    flock(guard, false);
    closeSync(guard);
  }
}
/** Bun warns that process.execve is experimental once an exec fails, on the
 * terminal of whatever ran Corgi. Drop that one warning; print the rest. */
let quietExecve = false;
function quietExecveWarning(): void {
  if (quietExecve) return;
  quietExecve = true;
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", warning => {
    if (warning.name === "ExperimentalWarning" && warning.message.startsWith("process.execve")) return;
    for (const listener of listeners) listener.call(process, warning);
  });
}
async function print<K extends protocol.Op>(path: string, op: K, ...args: protocol.Arguments<K>): Promise<void> {
  process.stdout.write(json.stringify(await rpc.request(path, op, ...args)) + "\n");
}
export async function run(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "attach",
    path = os.socketPath();
  quietExecveWarning();
  // Only the daemon logs native messages: its stderr is server.log.
  if (command === "serve" || command === "__handoff") n.native_log_stderr(true);
  if (["serve", "__handoff", "attach", "--no-update", "__viewer-test"].includes(command))
    try {
      crash.init(command === "serve" || command === "__handoff" ? "daemon" : "viewer");
    } catch (error) {
      console.error("crash reports are off:", error);
    }
  if (await updates.internal(args, executable)) return;
  const alias = providerAlias(os.processArgs(process.pid)?.argv[0] ?? process.argv[0]);
  if (alias) {
    const integration = await import("./integration");
    await integration.launch(alias, args, executable);
  }
  if (cli.handles(args)) {
    try {
      await cli.run(path, args);
    } catch (error) {
      cli.failure(error instanceof Error ? error.message : String(error), 2);
    }
    return;
  }
  switch (command) {
    case "--help":
    case "help":
      process.stdout.write(help + cli.help);
      return;
    case "--version":
      process.stdout.write(`corgi ${config.releaseVersion} (${config.releaseCommit})\n`);
      return;
    case "serve": {
      const { Server } = await import("./server");
      await new Server(path, executable, buildId()).run();
      return;
    }
    case "start":
      if (args[1] !== "--update-routed") await updates.startup(path, executable, ["start"]);
      await ensureServer(path);
      updates.background(path, executable);
      return;
    case "__update-start":
      await ensureServer(path);
      return;
    case "attach":
    case "--no-update": {
      if (process.env.CORGI_PANE) throw Error("NestedCorgi");
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("TerminalRequired");
      if (args[1] !== "--update-routed") await updates.startup(path, executable, ["attach"], command === "--no-update");
      await ensureServer(path);
      updates.background(path, executable);
      const client = await import("./client");
      await client.attach(path);
      return;
    }
    case "open": {
      const routed = args[1] === "--update-routed",
        rest = args.slice(routed ? 2 : 1);
      if (rest.length !== 1) throw Error("Usage");
      const folder = cli.directory(rest[0]);
      if (process.env.CORGI_PANE !== undefined) {
        await rpc.request(path, "action", { name: "open", value: folder, pane: paneId(process.env.CORGI_PANE) });
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("TerminalRequired");
      if (!routed) await updates.startup(path, executable, ["open", folder]);
      await ensureServer(path);
      updates.background(path, executable);
      try {
        crash.init("viewer");
      } catch (error) {
        console.error("crash reports are off:", error);
      }
      const client = await import("./client");
      await client.attach(path, folder);
      return;
    }
    case "onboard": {
      if (args.length !== 1) throw Error("Usage");
      if (process.env.CORGI_PANE !== undefined) {
        const pane = paneId(process.env.CORGI_PANE);
        await print(path, "action", { name: "onboard", pane });
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error("TerminalRequired");
      await ensureServer(path);
      try {
        crash.init("viewer");
      } catch (error) {
        console.error("crash reports are off:", error);
      }
      const client = await import("./client");
      await client.onboard(path);
      return;
    }
    case "__viewer-test": {
      if (!testBuild) throw Error("UnknownCommand");
      const client = await import("./client");
      await client.test(path);
      return;
    }
    case "ping":
      await print(path, "ping");
      return;
    case "shutdown":
      await print(path, "shutdown");
      for (let i = 0; i < 500; i++) {
        if (!(await ping(path))) return;
        await Bun.sleep(10);
      }
      throw Error("ShutdownTimedOut");
    case "checkpoint":
      await print(path, "recovery.save");
      return;
    case "reload":
      if (args.length > 2) throw Error("Usage");
      await print(path, "server.reload", { executable: args[1] ?? executable });
      return;
    case "__handoff": {
      const handoff = await import("./persist/handoff");
      await handoff.importAndRun(path, executable, Number(args[1]), Number(args[2]));
      return;
    }
    case "__herdr_import": {
      const importer = await import("./import");
      await importer.importBridge(args.slice(1));
      return;
    }
    case "rpc": {
      if (args.length !== 2) throw Error("Usage");
      const connection = new rpc.Connection(path);
      try {
        process.stdout.write(json.stringify(await connection.rawRequest(json.parse(args[1]))) + "\n");
      } finally {
        connection.close();
      }
      return;
    }
    case "action":
      if (args.length < 2) throw Error("Usage");
      await print(path, "action", { name: args[1], value: args[2] ?? "" });
      return;
    case "which": {
      if (args.length !== 2) throw Error("Usage");
      const d = await import("./discovery");
      process.stdout.write((await d.resolve(provider(args[1]))) + "\n");
      return;
    }
    case "keys": {
      const bindings = await import("./bindings");
      if (args.length > 2 || (args[1] && !["corgi", "tmux", "herdr", "cmux"].includes(args[1]))) throw Error("Usage");
      process.stdout.write(bindings.writeTable(args[1] ? [args[1] as Preset] : undefined));
      return;
    }
    case "hook": {
      if (args.length !== 2) throw Error("Usage");
      try {
        const integration = await import("./integration");
        await integration.hook(provider(args[1]), path);
      } catch {}
      return;
    }
    case "integration": {
      const integration = await import("./integration"),
        [op, name, ...rest] = args.slice(1);
      if (op === undefined || ["help", "--help", "-h"].includes(op) || args.includes("--help") || args.includes("-h"))
        return void process.stdout.write(integration.help);
      if (
        (op !== "status" && op !== "install" && op !== "uninstall") ||
        rest.length ||
        (name !== undefined && name !== "claude" && name !== "codex")
      ) {
        process.stderr.write(integration.help);
        process.exitCode = 2;
        return;
      }
      if (!(await integration.command(op, name === undefined ? null : provider(name)))) process.exitCode = 1;
      return;
    }
    case "hooks": {
      if (args.length !== 2) throw Error("Usage");
      const integration = await import("./integration");
      process.stdout.write(integration.config(provider(args[1]), executable) + "\n");
      return;
    }
    case "agent": {
      if (args.length < 2) throw Error("Usage");
      const integration = await import("./integration");
      await integration.launch(provider(args[1]), args.slice(2), executable);
      return;
    }
    case "native": {
      const op = args[1];
      if (op === "start") {
        if (args.length !== 3 && (args.length !== 5 || args[3] !== "--workspace")) throw Error("Usage");
        await ensureServer(path);
        await print(path, "native.start", {
          provider: provider(args[2]),
          cwd: process.cwd(),
          workspace: args[4] ? Number(args[4]) : null,
        });
      } else if (op === "list") await print(path, "native.list");
      else if (op === "stop" || op === "events")
        await print(path, `native.${op}`, {
          session: Number(args[2]),
          ...(op === "events" ? { after: Number(args[3] ?? 0) } : {}),
        });
      else if (op === "send" && args.length === 4)
        await print(path, "native.send", { session: Number(args[2]), message: json.parse(args[3]) });
      else throw Error("Usage");
      return;
    }
    case "dev": {
      await ensureServer(path);
      const hello = await rpc.request(path, "hello");
      if (hello.build_id !== buildId()) await rpc.request(path, "server.reload", { executable });
      if (process.env.CORGI_PANE !== undefined)
        await print(path, "action", { name: "relaunch", value: executable, pane: paneId(process.env.CORGI_PANE) });
      else {
        const c = await import("./client");
        await c.attach(path);
      }
      return;
    }
    case "update":
      await updates.command(args.slice(1), path, executable);
      return;
    default:
      throw Error("UnknownCommand");
  }
}
if (import.meta.main)
  run().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    if (["IncompatibleViewerProtocol", "UnsupportedViewerProtocol", "UnsupportedProtocol"].includes(message))
      process.stderr.write(
        "corgi: this viewer is incompatible with the server (requires viewer protocol 3). The server may have changed during a restart. Reattach using the same Corgi version as the server.\n",
      );
    else process.stderr.write(`corgi: ${message}\n`);
    if (process.env.CORGI_DEBUG) console.error(error);
    process.exitCode = 1;
  });
