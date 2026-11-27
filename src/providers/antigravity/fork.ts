import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandLine, InteractiveFork } from "../adapter";
import { field, str } from "../common";
import { shellQuote } from "../../os";
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
  if (value !== undefined) {
    if (!value.trimStart().startsWith("{")) value = resolve(line.cwd, value);
    args.push("--settings", value);
  }
  return { args, value };
}

/** Relay the original title command's stdin and stdout, even after the fork completes. */
function forkSettings(line: Pick<CommandLine, "args" | "cwd">, account: string, root: string) {
  const file = join(directory(account), "settings.json"),
    saved = existsSync(file) ? settings(readFileSync(file, "utf8")) : {},
    { value } = launchSettings(line),
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

export function interactiveFork(
  source: string,
  line: Pick<CommandLine, "args" | "cwd">,
  account: string,
): InteractiveFork {
  const root = scratch.temporary(),
    file = join(root, "settings.json"),
    state = join(root, "state.json");
  try {
    writeFileSync(file, JSON.stringify(forkSettings(line, account, root)), { mode: 0o600 });
  } catch (error) {
    scratch.remove(root);
    throw error;
  }
  return {
    args: ["--settings", file],
    env: [["AGY_CLI_DISABLE_AUTO_UPDATE", "true"]],
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
