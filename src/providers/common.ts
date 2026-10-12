import { BoundedText } from "../bounded_text";
import path from "node:path";
import { field, str } from "../json";
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
export class Info {
  [key: string]: any;
  constructor(fields: Record<string, any>) {
    Object.assign(
      this,
      {
        install_markers: [],
        scripts: [],
        app_bundles: [],
        version_prefix: null,
        fork_session_flag: null,
        name_flag: null,
        oauth_env: null,
        model_env: null,
        prompt_turns: false,
        children_at_stop: false,
        screen: {},
      },
      fields,
    );
  }
  configDir(env = process.env) {
    const configured = env[this.config_env];
    if (configured !== undefined) return configured;
    if (!env.HOME) throw Error("NoHome");
    return path.join(env.HOME, this.config_dir);
  }
  resumeArgs(ref: SessionRef) {
    if (!("id" in ref) || !validRef(ref)) throw Error("InvalidSessionRef");
    return [...this.resume_args, ref.id];
  }
  envOverride(name: string, value: string): "credential" | "oauth" | "endpoint" | null {
    if (!value) return null;
    if (this.credential_env.includes(name)) return "credential";
    if (name === this.oauth_env) return "oauth";
    if (this.endpoint_env.includes(name)) return "endpoint";
    if (this.provider_env.includes(name) && /^(1|true|yes|on)$/i.test(value.trim())) return "endpoint";
    return null;
  }
}
export class Text extends BoundedText(Infinity) {}

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
export type NativeEvent = {
  session: string;
  thread: string;
  turn: string;
  phase: "none" | "working" | "completed";
  outcome: Outcome;
  request_id: any;
  response_id: any;
  initialize: boolean;
  initialization_failed: boolean;
  tool_request: boolean;
};
export function nativeEvent(fields: Partial<NativeEvent> = {}): NativeEvent {
  return {
    session: "",
    thread: "",
    turn: "",
    phase: "none",
    outcome: "completed",
    request_id: null,
    response_id: null,
    initialize: false,
    initialization_failed: false,
    tool_request: false,
    ...fields,
  };
}
export const HookEvent = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "Stop",
  "Interrupt",
  "SessionEnd",
  "Notification",
] as const;
export type Hook = ReturnType<Hooks["decode"]>;
/** Where Claude's EnterWorktree and ExitWorktree report moving the session. */
const moves: Record<string, string> = { EnterWorktree: "worktreePath", ExitWorktree: "restoredCwd" };
export class Hooks {
  decode(v: any) {
    if (!v || typeof v !== "object" || Array.isArray(v) || str(v, "agent_id")) return null;
    const kinds: Record<string, string> = {
      SessionStart: "session_start",
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
    const kind = kinds[str(v, "hook_event_name")];
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
      session: str(v, "session_id"),
      turn: str(v, "turn_id"),
      prompt: str(v, "prompt_id"),
      transcript: str(v, "transcript_path"),
      cwd: str(v, "cwd"),
      model: str(v, "model"),
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
      subagent: launched ? str(response, "agentId") : "",
      subagent_type: launched ? str(input, "subagent_type") : "",
      target:
        ["file_path", "notebook_path", "pattern", "query", "url", "command", "skill"]
          .map(k => str(input, k))
          .find(Boolean) ?? "",
      asking: kind === "tool_start" && ["AskUserQuestion", "request_user_input"].includes(tool),
      permission_notification: kind === "notification" && notification === "permission_prompt",
    };
  }
}
