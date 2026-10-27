//! omp's RPC mode: Pi's protocol, where a run ends at session_settled.
import { field, str } from "../common";
import type { Inference } from "../adapter";
import type { Outcome } from "../../observation";
import { Pi } from "../pi/headless";
import { truncateUtf8 } from "../../bounded_text";

/** Native labels are not summaries: preserve their wording, but keep UI text bounded. */
export function nativeIntent(value: unknown): string {
  if (typeof value !== "string") return "";
  return truncateUtf8(
    Bun.stripANSI(value)
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*\.+$/, "")
      .trim(),
    160,
  ).trimEnd();
}

/** The footer follows the last tool carrying an intent, even while args stream. */
export function messageIntent(message: unknown): { id: string; text: string } | null {
  if (str(message, "role") !== "assistant") return null;
  const content = field(message, "content");
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (str(block, "type") !== "toolCall") continue;
    const text = nativeIntent(field(block, "intent")) || nativeIntent(field(field(block, "arguments"), "i"));
    if (text) return { id: str(block, "id"), text };
  }
  return null;
}

export function summaryArgs(r: Inference) {
  return [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-tools",
    "--no-lsp",
    "--no-pty",
    "--no-title",
    "--thinking",
    "low",
    "--system-prompt",
    r.instructions + (r.schema ? "\nReturn only JSON conforming to this schema:\n" + r.schema : ""),
    ...(r.model ? ["--model", r.model] : []),
  ];
}
function outcome(status: string): Outcome {
  switch (status) {
    case "aborted":
      return "interrupted";
    case "error":
      return "failed";
    default:
      return "completed";
  }
}
export class Omp extends Pi {
  protected static override readonly mode = "rpc-ui" as const;
  private activityTool = "";
  private activityText = "";

  private activity(id: string, text: string) {
    if (!this.ready || !this.session || !this.turn || !id || !text) return;
    const amend = id === this.activityTool;
    if (amend && text === this.activityText) return;
    this.activityTool = id;
    this.activityText = text;
    this.events.push({ kind: "activity", session: this.session, turn: this.turn, text, amend });
  }

  override settled(aborted: boolean) {
    super.settled(aborted);
    this.activityTool = "";
    this.activityText = "";
  }

  abort() {
    // Withdraws queued prompts first, so the abort doesn't run them.
    this.command({ id: `corgi-abort-${++this.next}`, type: "abort_and_restore_queue" });
  }
  decode(v: unknown) {
    switch (str(v, "type")) {
      case "message_update": {
        const intent = messageIntent(field(v, "message"));
        if (intent) this.activity(intent.id, intent.text);
        return;
      }
      case "tool_execution_start": {
        super.decode(v);
        const id = str(v, "toolCallId"),
          args = field(v, "args"),
          intent = nativeIntent(field(v, "intent")) || nativeIntent(field(args, "i"));
        this.activity(id, intent);
        return;
      }
      case "session_settled":
        this.settled(false);
        return;
      // A slash command, or a prompt that failed before reaching the model, runs nothing.
      case "response":
        super.decode(v);
        if (
          str(v, "command") === "prompt" &&
          field(v, "success") === true &&
          field(field(v, "data"), "agentInvoked") === false &&
          !this.turn
        )
          this.events.push({ kind: "turn", session: this.session, turn: "", phase: "ended", outcome: "completed" });
        return;
      case "prompt_result":
        if (field(v, "agentInvoked") === false && !this.turn)
          this.events.push({
            kind: "turn",
            session: this.session,
            turn: "",
            phase: "ended",
            outcome: outcome(str(v, "status")),
          });
        return;
      default:
        super.decode(v);
    }
  }
}
