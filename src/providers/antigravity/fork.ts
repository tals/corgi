import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CommandLine, ForkSource, PreparedFork } from "../adapter";
import { field, str } from "../common";
import { processArgs, processCwd, shellQuote } from "../../os";
import { directory, validSession } from "./config";
import * as scratch from "./private";
import { rename } from "./screen";

function settings(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("InvalidForkSettings");
  return value as Record<string, unknown>;
}

/** agy applies only the last --settings. Preserve its meaning when the next launch changes directory. */
export function launchSettings(line: Pick<CommandLine, "args" | "cwd">) {
  const args: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < line.args.length; i++) {
    const arg = line.args[i];
    if (arg === "--settings") value = line.args[++i];
    else if (arg.startsWith("--settings=")) value = arg.slice("--settings=".length);
    else args.push(arg);
  }
  const original = value;
  if (value !== undefined) {
    if (!value.trimStart().startsWith("{")) value = resolve(line.cwd, value);
    args.push("--settings", value);
  }
  return { args, value, original };
}

/** Relay the original title command's stdin and stdout, even after the fork completes. */
function forkSettings(value: string | undefined, account: string, root: string) {
  const file = join(directory(account), "settings.json"),
    saved = existsSync(file) ? settings(readFileSync(file, "utf8")) : {},
    overrides =
      value === undefined ? {} : settings(value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8")),
    title = Object.hasOwn(overrides, "title") ? overrides.title : saved.title,
    original = field(title, "enabled") === false ? "" : str(title, "command"),
    open = "[ -d " + shellQuote(root) + " ]",
    state = shellQuote(join(root, "state.json")),
    command = original
      ? `if ${open}; then tee ${state}; else cat; fi | /bin/sh -c ${shellQuote(original)}`
      : `if ${open}; then cat > ${state}; fi`;
  return { ...overrides, title: { type: "command", enabled: true, command } };
}

function idleSession(file: string) {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8")),
      id = str(value, "conversation_id");
    return field(value, "agent_state") === "idle" && validSession(id) ? id : null;
  } catch {
    // The callback may still be writing its JSON.
    return null;
  }
}

const disableUpdates = "AGY_CLI_DISABLE_AUTO_UPDATE";
/** A saved command can replace the environment that Corgi passes to its shell. */
function launcherEnablesUpdates(shell: CommandLine) {
  let value = shell.env.findLast(([key]) => key === disableUpdates)?.[1];
  const args = basename(shell.args[0] ?? "") === "env" ? shell.args.slice(1) : shell.flagged ? shell.args : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-i" || arg === "--ignore-environment") value = "";
    else if (arg.startsWith("--unset=")) {
      if (arg.slice(8) === disableUpdates) value = "";
    } else if (arg === "-u" || arg === "--unset") {
      if (args[++i] === disableUpdates) value = "";
    } else if (arg.startsWith(disableUpdates + "=")) value = arg.slice(disableUpdates.length + 1);
    else if (arg !== "--" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) break;
  }
  return value !== undefined && value !== "true";
}

export function interactiveFork(source: string, launch: ForkSource): PreparedFork {
  if (launch.shell && launcherEnablesUpdates(launch.shell)) throw Error("ForkLauncherEnablesAutoUpdate");
  const saved = launchSettings(launch.shell ?? launch),
    proc = launch.pid > 0 ? processArgs(launch.pid) : null,
    current = proc?.complete
      ? launchSettings({ args: proc.argv, cwd: processCwd(launch.pid) ?? launch.cwd }).value
      : undefined,
    // A previous fork's last --settings is its temporary reporter. Its saved launcher still has the original.
    temporary = current && basename(current) === "settings.json" && scratch.temporaryDirectory(dirname(current)),
    value = (temporary ? undefined : current) ?? saved.value,
    root = scratch.temporary(),
    file = join(root, "settings.json"),
    state = join(root, "state.json");
  try {
    writeFileSync(file, JSON.stringify(forkSettings(value, launch.account, root)), { mode: 0o600 });
  } catch (error) {
    scratch.remove(root);
    throw error;
  }
  return {
    keep: value !== undefined && value !== saved.original ? ["--settings", value] : [],
    args: ["--settings", file],
    env: [[disableUpdates, "true"]],
    close: () => scratch.remove(root),
    async finish(t, live) {
      const { paste, enter } = await import("../../agent_message");
      let phase: "ready" | "pasted" | "submitted" = "ready",
        deadline = Date.now() + 15000,
        revision = 0;
      while (live() && !t.exited && !t.hung_up && Date.now() < deadline) {
        if (t.input_revision !== revision) break;
        const session = idleSession(state);
        if (phase === "submitted") {
          if (session && session !== source) return session;
        } else if (session === source && t.bracketed_paste) {
          if (phase === "ready" && rename.empty(t)) {
            t.send(paste(t, "/fork"));
            phase = "pasted";
            deadline = Date.now() + 2000;
            revision = t.input_revision;
          } else if (phase === "pasted" && rename.holds(t, "/fork")) {
            t.send(enter(t));
            phase = "submitted";
            deadline = Date.now() + 10000;
            revision = t.input_revision;
          }
        }
        await Bun.sleep(50);
      }
      throw Error(phase === "submitted" ? "ForkUnconfirmed" : "ForkNotReady");
    },
  };
}
