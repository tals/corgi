#!/usr/bin/env bun
/** Development launcher: build, retire other daemons, then start or attach. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isatty } from "node:tty";
import { stopOtherDaemons } from "./scripts/stop-other-daemons.ts";
import type { Sandbox } from "./tools/sandbox.ts";

const usage = `Usage: bun run go.ts [--temp | --env NAME | --sandbox NAME] [--reload | --restart] [COMMAND ...]

  --temp          Fresh isolated Corgi environment on every launch
  --env NAME      Reuse a named environment with its own setup and saved state
  --sandbox NAME  Try a feature in a seeded world with fake agents, apart from
                  your own Corgi and settings (tools/sandboxes/NAME.ts)
  --reload        Rebuild and reload the selected runtime without stopping panes
  --restart       Confirm before stopping and restarting the selected runtime;
                  a sandbox starts over from its seed without asking

With no command, start or attach. Use "onboard" to reopen onboarding.
Launching the main environment stops all other Corgi daemons owned by you.
Temporary runtimes keep running after detach; shutdown still asks for confirmation.`;

const root = import.meta.dir;
const binary = join(root, "dist/corgi");
const uid = process.getuid!();
let env: Record<string, string | undefined> = process.env;

function fail(message: string): never {
  console.error(`corgi: ${message}`);
  process.exit(1);
}

/** Runs to completion with this terminal; a failure ends the launch with its status. */
function run(command: string[], quiet: "stdout" | "all" | "" = "") {
  const result = Bun.spawnSync(command, {
    env,
    stdin: "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet === "all" ? "ignore" : "inherit",
  });
  return result.exitCode ?? 128 + (constants.signals[result.signalCode as keyof typeof constants.signals] ?? 0);
}
function must(command: string[], quiet: "stdout" | "" = "") {
  const status = run(command, quiet);
  if (status !== 0) process.exit(status);
}

function readLine(): string | undefined {
  const byte = Buffer.alloc(1);
  let line = "";
  while (readSync(0, byte, 0, 1, null) === 1) {
    if (byte[0] === 10) return line;
    line += String.fromCharCode(byte[0]);
  }
  return undefined;
}

function confirmShutdown() {
  console.error("corgi: this will terminate all subterminals and their running processes.");
  if (!isatty(0)) fail("confirmation requires an interactive terminal; cancelled.");
  process.stderr.write("Terminate them? Type yes to confirm [no]: ");
  if (readLine() !== "yes") fail("cancelled; subterminals were left running.");
}

let args = process.argv.slice(2);
let environment: "temp" | "named" | "sandbox" | undefined;
let environmentName = "";
let action: "--reload" | "--restart" | undefined;
while (args.length) {
  const [arg] = args;
  if (arg === "--temp" || arg === "--env" || arg === "--sandbox") {
    if (environment) fail("choose one of --temp, --env NAME or --sandbox NAME, once");
    if (arg === "--temp") {
      environment = "temp";
      args = args.slice(1);
      continue;
    }
    if (args.length < 2) fail(`${arg} requires a name`);
    environment = arg === "--env" ? "named" : "sandbox";
    environmentName = args[1];
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(environmentName)) {
      fail("names must start with a letter or digit and contain only letters, digits, _ or -");
    }
    if (environmentName.length > 32) fail("names must be at most 32 characters");
    args = args.slice(2);
  } else if (arg === "--reload" || arg === "--restart") {
    if (action) fail("choose either --reload or --restart, once");
    action = arg;
    args = args.slice(1);
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage);
    process.exit(0);
  } else {
    if (arg === "--") args = args.slice(1);
    break;
  }
}

if (environment === "temp" || environment === "named") {
  // Retain the original state root in child shells so selecting another named
  // environment never nests it inside the current environment's XDG root.
  const base = resolve(
    env.PWD || process.cwd(),
    env.CORGI_ENV_BASE || env.XDG_STATE_HOME || join(env.HOME!, ".local/state"),
  );
  let dir: string, socket: string;
  if (environment === "temp") {
    if (env.CORGI_PANE) fail("launch a fresh environment from a terminal outside Corgi");
    dir = mkdtempSync(`/tmp/corgi-temp-${uid}.`);
    socket = join(dir, "control.sock");
  } else {
    dir = join(base, "corgi/environments", environmentName);
    // Keep AF_UNIX paths short even when the state directory is long. Include
    // the full state path so different state roots cannot share a runtime.
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 32);
    socket = `/tmp/corgi-env-${uid}-${hash}/control.sock`;
    if (env.CORGI_PANE && env.CORGI_SOCKET !== socket)
      fail("launch a different environment from a terminal outside Corgi");
  }
  // Only newly created directories are private; existing ones keep their permissions.
  for (const path of [join(dir, "state"), dirname(socket)]) mkdirSync(path, { recursive: true, mode: 0o700 });
  Object.assign(env, {
    CORGI_SOCKET: socket,
    XDG_STATE_HOME: join(dir, "state"),
    CORGI_ENV_BASE: base,
    CORGI_ENV_DIR: dir,
  });
  if (environment === "temp") {
    console.error(`corgi: temporary environment ${dir}`);
    console.error(
      `corgi: reconnect: CORGI_ENV_DIR=${dir} CORGI_SOCKET=${socket} XDG_STATE_HOME=${env.XDG_STATE_HOME} bun run go.ts`,
    );
  } else {
    console.error(`corgi: environment ${environmentName} (${dir})`);
  }
}

must([process.execPath, join(root, "build.ts")]);
// A sandbox has its own HOME, so it switches over after the build, which needs yours.
let sandbox: Sandbox | undefined;
if (environment === "sandbox") {
  const { open } = await import("./tools/sandbox.ts");
  try {
    sandbox = await open(environmentName, root, binary, action === "--restart");
  } catch (error) {
    fail((error as Error).message);
  }
  env = sandbox.env;
}
const mainSocket = `/tmp/corgi-${uid}/control.sock`;
if (!environment && (env.CORGI_SOCKET || mainSocket) === mainSocket) await stopOtherDaemons(mainSocket);

if (action === "--reload") {
  must([binary, "reload"]);
  if (!args.length) process.exit(0);
}
if (action === "--restart" && !sandbox && run([binary, "ping"], "all") === 0) {
  confirmShutdown();
  must([binary, "shutdown"], "stdout");
  // Shutdown acknowledges before cleanup finishes. Wait for the old socket to
  // disappear so startup cannot reattach to the exiting server.
  const socket = env.CORGI_SOCKET || mainSocket;
  const end = Date.now() + 5000;
  while (existsSync(socket)) {
    if (Date.now() > end) fail("runtime did not stop within 5 seconds");
    await Bun.sleep(50);
  }
}
if (args[0] === "shutdown") confirmShutdown();
if (!args.length) args = ["dev"];
if (sandbox && args[0] === "dev") console.error(sandbox.intro());

// Bun cannot exec, so the client runs as a child that owns the terminal: keystroke
// signals reach it directly, and signals sent to the launcher are passed on.
const client = Bun.spawn([binary, ...args], { env, cwd: sandbox?.dir, stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGQUIT"] as const) process.on(signal, () => {});
for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => client.kill(signal));
const status = await client.exited;
process.exit(client.signalCode ? 128 + (constants.signals[client.signalCode] ?? 0) : status);
