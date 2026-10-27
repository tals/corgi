import { readdirSync } from "node:fs";
import { BoundedText } from "../bounded_text";
import path from "node:path";
import { field, str } from "../json";
import type { Permissions, Programs } from "./adapter";
export { field, str } from "../json";
export type Outcome = "completed" | "interrupted" | "failed";
export type SessionRef = { id: string } | { path: string };
export const refText = (r: SessionRef) => ("id" in r ? r.id : r.path);
export function validRef(r: SessionRef) {
  const s = refText(r);
  return (
    s.length > 0 && Buffer.byteLength(s) <= 4096 && !/[\x00-\x1f\x7f]/.test(s) && ("id" in r || path.isAbsolute(s))
  );
}
export class Text extends BoundedText(Infinity) {}
/** A token count `v` reports at `key`: a whole number that fits 64 bits. */
export function number(v: any, key: string): bigint | null {
  const n = field(v, key);
  if (typeof n === "bigint") return n >= 0n && n <= (1n << 64n) - 1n ? n : null;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null;
}
/** A provider's settings directory: `variable` when it's set, else `dir` in HOME. */
export function configHome(env: NodeJS.ProcessEnv, variable: string, dir: string) {
  const configured = env[variable];
  if (configured !== undefined) return configured;
  if (!env.HOME) throw Error("NoHome");
  return path.join(env.HOME, dir);
}
/** `command` inside macOS app bundles: `names` first, then every other app,
 * in the user's Applications and then the system's. */
export function appBundles(names: string[], command: string, at: { home: string | null; root: string }) {
  if (process.platform !== "darwin") return [];
  const paths: string[] = [];
  for (const apps of [at.home ? path.join(at.home, "Applications") : null, at.root + "/Applications"]) {
    if (!apps) continue;
    let found: string[] = [];
    try {
      found = readdirSync(apps)
        .filter(x => x.endsWith(".app"))
        .sort();
    } catch {}
    for (const name of [...names, ...found]) paths.push(path.join(apps, name, "Contents/Resources", command));
  }
  return paths;
}
/** A screen's last rows, lowercased, as screen readers compare them. */
export function screenTail(screen: string) {
  return screen.trimEnd().split("\n").slice(-8).join("\n").slice(0, 8192).toLowerCase();
}
/** What the prompts Claude Code and Codex share show: a question waiting
 * for an answer, or a turn the user can interrupt. */
export function sharedPrompt(screen: string): "initializing" | "blocked" | "working" | null {
  const text = screenTail(screen);
  if (
    (text.includes("enter to confirm") && text.includes("esc to cancel")) ||
    text.includes("enter to submit answer") ||
    text.includes("enter to submit all")
  )
    return "blocked";
  if (text.includes("initializing (esc to interrupt)")) return "initializing";
  return text.includes("esc to interrupt") ? "working" : null;
}

export function planLabel(code: string) {
  return new Text(
    code
      .split(/[_ ]+/)
      .filter(Boolean)
      .map(w => w[0].toUpperCase() + w.slice(1))
      .join(" ")
      .slice(0, 160),
  );
}
export function timestampMs(s: string): number | null {
  if (s.length < 20 || s[4] !== "-" || s[7] !== "-" || s[10] !== "T" || !s.endsWith("Z")) return null;
  const n = [s.slice(0, 4), s.slice(5, 7), s.slice(8, 10), s.slice(11, 13), s.slice(14, 16), s.slice(17, 19)];
  if (n.some(x => !/^\d+$/.test(x))) return null;
  const [y, m, d, h, min, sec] = n.map(Number);
  if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || sec > 59) return null;
  let ms = 0;
  if (s.length >= 24 && s[19] === ".") {
    if (!/^\d{3}$/.test(s.slice(20, 23))) return null;
    ms = Number(s.slice(20, 23));
  }
  return Date.UTC(y, m - 1, d, h, min, sec, ms);
}
export type Hook = ReturnType<Hooks["decode"]>;
/** Where Claude's EnterWorktree and ExitWorktree report moving the session. */
const moves: Record<string, string> = { EnterWorktree: "worktreePath", ExitWorktree: "restoredCwd" };
export class Hooks {
  decode(v: any) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const session_kinds: Record<string, string> = {
      SessionStart: "session_start",
      Idle: "idle",
      UserPromptSubmit: "prompt",
      PreToolUse: "tool_start",
      PostToolUse: "tool_finish",
      PostToolUseFailure: "tool_failure",
      PermissionRequest: "permission",
      PreCompact: "compact_start",
      PostCompact: "compact_end",
      Stop: "stop",
      Interrupt: "interrupt",
      SessionEnd: "session_end",
      Notification: "notification",
    };
    // A subagent's own hooks name it in agent_id; only its start and stop
    // are news to the session that runs it.
    const subagent_kinds: Record<string, string> = {
      SubagentStart: "subagent_start",
      SubagentStop: "subagent_stop",
    };
    const agent = str(v, "agent_id"),
      kind = (agent ? subagent_kinds : session_kinds)[str(v, "hook_event_name")];
    const notification = str(v, "notification_type");
    if (!kind || (kind === "notification" && !["permission_prompt", "elicitation_dialog"].includes(notification)))
      return null;
    const tool = str(v, "tool_name"),
      input = field(v, "tool_input"),
      response = field(v, "tool_response"),
      launched = kind === "tool_finish" && str(response, "status") === "async_launched",
      moved = kind === "tool_finish" && moves[tool] ? str(response, moves[tool]) : "";
    return {
      kind,
      /** A provider settlement event, unlike a pre-completion Stop hook. */
      outcome: null as Outcome | null,
      session: str(v, "session_id"),
      turn: str(v, "turn_id"),
      prompt: str(v, "prompt_id"),
      initial_request: "",
      transcript: str(v, "transcript_path"),
      cwd: str(v, "cwd"),
      model: str(v, "model"),
      /** The permission checks it runs with now, when it says. */
      permissions: (str(v, "permission_mode") === "bypassPermissions"
        ? "bypass"
        : str(v, "permission_mode")
          ? "default"
          : null) as Permissions | null,
      tool,
      writes:
        kind === "tool_finish" &&
        !field(response, "is_error") &&
        ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)
          ? [str(input, "file_path") || str(input, "notebook_path")]
              .filter(p => p.length > 0 && (path.isAbsolute(p) || path.isAbsolute(str(v, "cwd"))))
              .map(p => path.resolve(str(v, "cwd"), p))
          : [],
      location: path.isAbsolute(moved) ? moved : "",
      description: str(input, "description"),
      background_tasks: field(v, "background_tasks"),
      session_crons: field(v, "session_crons"),
      subagent: agent || (launched ? str(response, "agentId") : ""),
      subagent_type: agent ? str(v, "agent_type") : launched ? str(input, "subagent_type") : "",
      target:
        ["file_path", "notebook_path", "pattern", "query", "url", "command", "skill"]
          .map(k => str(input, k))
          .find(Boolean) ?? "",
      asking: kind === "tool_start" && ["AskUserQuestion", "request_user_input"].includes(tool),
      permission_notification: kind === "notification" && notification === "permission_prompt",
      /** A permission hook blocks the agent at once, or only once its screen shows the prompt. */
      confirm: "now" as "now" | "screen",
    };
  }
}
/** Whether an executable, script or package at `path` is the one `programs` describes. */
export function owns(programs: Programs, p: string): boolean {
  return (
    programs.names.includes(path.basename(p)) ||
    (programs.markers ?? []).some(marker => p.includes(marker)) ||
    (programs.scripts ?? []).some(script => p.endsWith(script))
  );
}
