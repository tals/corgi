//! Claude Code's transcripts: the records it writes, and what they say about
//! a turn ending or a conversation's activity.
import { field, str } from "../common";
import type { Transcript } from "../adapter";
export const MessageType = ["assistant", "user", "result", "control_request", "control_response"] as const;
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
    const fields = content.slice(0, at >= 0 ? at : ev >= 0 ? ev : content.length);
    const element = (k: string) => fields.match(new RegExp("<" + k + ">([\\s\\S]*?)</" + k + ">"))?.[1] ?? null;
    const id = element("task-id"),
      status = element("status");
    return id === null ? null : { id, status: TaskStatus.includes(status as any) ? status : null };
  }
}
export class Line {
  type: string | null = null;
  subtype = "";
  sessionId = "";
  agentId = "";
  timestamp = "";
  isSidechain = false;
  isCompactSummary = false;
  thinkingUpdates = false;
  message: any = null;
  static parse(v: any) {
    return Object.assign(new Line(), {
      type: TranscriptLine.includes(str(v, "type") as any) ? str(v, "type") : null,
      subtype: str(v, "subtype"),
      sessionId: str(v, "sessionId"),
      agentId: str(v, "agentId"),
      timestamp: str(v, "timestamp"),
      isSidechain: field(v, "isSidechain") === true,
      isCompactSummary: field(v, "isCompactSummary") === true,
      thinkingUpdates: str(v, "thinkingDisplay") === "updates",
      message: field(v, "message"),
    });
  }
  /** Assistant text and the thinking updates Claude displays as progress. */
  commentary(block: unknown): string {
    if (this.type !== "assistant") return "";
    switch (str(block, "type")) {
      case "text":
        return str(block, "text");
      case "thinking":
        return this.thinkingUpdates ? str(block, "thinking") : "";
      default:
        return "";
    }
  }
  /** A prompt or tool result opens a turn; `turn_duration`, or the notice
   * written in its place on an interrupt, closes it. Compaction summaries and
   * local slash commands leave it as it was. */
  turn(): "open" | "closed" | null {
    if (this.type === "system") return this.subtype === "turn_duration" ? "closed" : null;
    if (this.type !== "user" || this.isCompactSummary) return null;
    const content = field(this.message, "content");
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? str(
              content.find(b => str(b, "type") === "text"),
              "text",
            )
          : "";
    if (text.startsWith("[Request interrupted")) return "closed";
    if (text.startsWith("<command-name>") || text.startsWith("<local-command-")) return null;
    return "open";
  }
  static decode(v: any) {
    const l = this.parse(v);
    return l.isSidechain ? null : l;
  }
  static of(v: any, conversation: string) {
    const l = this.parse(v);
    return (l.isSidechain ? l.agentId : l.sessionId) === conversation ? l : null;
  }
}
export const transcript: Omit<Transcript, "reader"> = {
  completion(agent, v) {
    const decoded = Line.decode(v);
    if (!decoded || decoded.sessionId !== agent.sessionId()) return null;
    if (decoded.type === "system" && decoded.subtype === "turn_duration") return "completed";
    // A Stop hook cancelled before it timed out ends the turn as interrupted.
    const attachment = field(v, "attachment");
    if (
      decoded.type === "attachment" &&
      str(attachment, "type") === "hook_cancelled" &&
      str(attachment, "hookEvent") === "Stop" &&
      field(attachment, "timedOut") === false
    )
      return "interrupted";
    return null;
  },
  // Claude Code writes no `turn_duration` while the session leads teammates,
  // so a Stop hook summary the model doesn't answer ends the turn too. A
  // blocking Stop hook hands its reason back, and the model goes on.
  settling(agent, v) {
    const decoded = Line.decode(v);
    if (!decoded || decoded.sessionId !== agent.sessionId()) return null;
    if (decoded.type === "system" && decoded.subtype === "stop_hook_summary") return "settles";
    if (decoded.type === "user" || decoded.type === "assistant") return "continues";
    const attachment = field(v, "attachment");
    if (
      decoded.type === "attachment" &&
      str(attachment, "type") === "hook_blocking_error" &&
      str(attachment, "hookEvent") === "Stop"
    )
      return "continues";
    return null;
  },
  fallback(r, agent) {
    if (r.name.len) agent.setName(r.name.text());
    if (agent.state === "working" && !agent.activity_inferred && r.update.len && r.update_at > agent.activity_at) {
      agent.setActivity(r.update.text());
      agent.activity_at = r.update_at;
    }
    const p = r.progress;
    if (
      !p ||
      agent.state !== "working" ||
      p.ended ||
      !p.turn.len ||
      agent.turnId() !== p.turn.text() ||
      (!p.commentary.len && !p.evidence.len)
    )
      return false;
    agent.activity_generation = Bun.hash.wyhash(agent.turnId(), 0n);
    return true;
  },
};
