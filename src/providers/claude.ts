import path from "node:path";
import { field, str, Hooks, nativeEvent, planLabel } from "./common";
import { info } from "./claude_info";
export const MessageType = [
  "assistant",
  "user",
  "result",
  "control_request",
  "control_response",
] as const;
export const BlockType = ["text", "tool_use", "tool_result"] as const;
export const TranscriptLine = [
  "assistant",
  "user",
  "system",
  "attachment",
  "agent-name",
  "custom-title",
  "ai-title",
  "continued-in",
  "queue-operation",
] as const;
export const TaskStatus = ["completed", "failed", "killed", "stopped"] as const;
export class TaskNotice {
  static decode(content: string) {
    if (!content.trimStart().startsWith("<task-notification>")) return null;
    const at = content.indexOf("<summary>"),
      ev = content.indexOf("<event>");
    const fields = content.slice(
      0,
      at >= 0 ? at : ev >= 0 ? ev : content.length,
    );
    const element = (k: string) =>
      fields.match(new RegExp("<" + k + ">([\\s\\S]*?)</" + k + ">"))?.[1] ??
      null;
    const id = element("task-id"),
      status = element("status");
    return id === null
      ? null
      : { id, status: TaskStatus.includes(status as any) ? status : null };
  }
}
export class Line {
  type: string | null = null;
  subtype = "";
  sessionId = "";
  agentId = "";
  timestamp = "";
  isSidechain = false;
  message: any = null;
  static parse(v: any) {
    return Object.assign(new Line(), {
      type: TranscriptLine.includes(str(v, "type") as any)
        ? str(v, "type")
        : null,
      subtype: str(v, "subtype"),
      sessionId: str(v, "sessionId"),
      agentId: str(v, "agentId"),
      timestamp: str(v, "timestamp"),
      isSidechain: field(v, "isSidechain") === true,
      message: field(v, "message"),
    });
  }
  static decode(v: any) {
    const l = this.parse(v);
    return l.isSidechain ? null : l;
  }
  static of(v: any, conversation: string) {
    const l = this.parse(v);
    return (l.isSidechain ? l.agentId : l.sessionId) === conversation
      ? l
      : null;
  }
}
export class Claude {
  static info = info;
  static MessageType = MessageType;
  static BlockType = BlockType;
  static TranscriptLine = TranscriptLine;
  static TaskStatus = TaskStatus;
  static TaskNotice = TaskNotice;
  static Line = Line;
  static hook_events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
    "PreCompact",
    "Notification",
    "PostToolUseFailure",
  ];
  hooks = new Hooks();
  hook(v: any) {
    return this.hooks.decode(v);
  }
  nativeEvent(v: any) {
    const kind = str(v, "type");
    return nativeEvent({
      session: str(v, "session_id"),
      phase:
        kind === "assistant"
          ? "working"
          : kind === "result"
            ? "completed"
            : "none",
      outcome: field(v, "is_error") === true ? "failed" : "completed",
      request_id: kind === "control_request" ? field(v, "request_id") : null,
      response_id:
        kind === "control_response"
          ? field(field(v, "response"), "request_id")
          : null,
      tool_request:
        kind === "control_request" &&
        str(field(v, "request"), "subtype") === "can_use_tool",
    });
  }
  static titleSession(_title: string) {
    return null;
  }
  static subagentTranscript(
    transcript: string,
    session: string,
    agent: string,
  ) {
    return path.join(
      path.dirname(transcript),
      session,
      "subagents",
      `agent-${agent}.jsonl`,
    );
  }
  static plan(kind: string, tier: string) {
    const code = (s: string) =>
      s.replace(/^default_/, "").replace(/^claude_/, "");
    const named = planLabel(code(kind)),
      refined = planLabel(code(tier));
    return named.len > 0 && refined.text().startsWith(named.text())
      ? refined
      : named;
  }
}
