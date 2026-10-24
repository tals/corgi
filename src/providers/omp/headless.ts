//! omp's RPC mode: Pi's protocol, where a run ends at session_settled.
import { field, str } from "../common";
import type { Inference } from "../adapter";
import type { Outcome } from "../../observation";
import { Pi } from "../pi/headless";
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
  abort() {
    // Withdraws queued prompts first, so the abort doesn't run them.
    this.command({ id: `corgi-abort-${++this.next}`, type: "abort_and_restore_queue" });
  }
  decode(v: unknown) {
    switch (str(v, "type")) {
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
