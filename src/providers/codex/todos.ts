import { field, str, timestampMs } from "../common";
import { List, type Status } from "../../activity/checklist";
import { Rollout } from "./transcript";
const statuses: Record<string, Status> = { pending: "pending", in_progress: "active", completed: "done" };
/** A plan is confirmed by the tool result, not its proposed arguments. */
const statusOf = (raw: string): Status | null => (Object.hasOwn(statuses, raw) ? statuses[raw] : null);
export class Reader {
  pending = new Map<string, List>();
  record(value: unknown): List | null {
    const r = Rollout.decode(value),
      p = r.payload;
    if (r.type !== "response_item") return null;
    const id = str(p, "call_id");
    if (!id) return null;
    if (r.payloadType() === "function_call" && /(?:^|[._])update_plan$/.test(str(p, "name"))) {
      let input: unknown;
      try {
        input = JSON.parse(str(p, "arguments"));
      } catch {
        return null;
      }
      const steps = field(input, "plan");
      if (!Array.isArray(steps)) return null;
      let partial = false;
      const items = steps.flatMap(step => {
        const status = statusOf(str(step, "status")),
          text = str(step, "step");
        if (!status || !text) {
          partial = true;
          return [];
        }
        return [{ text, status }];
      });
      if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(id, List.of(items, partial));
    } else if (r.payloadType() === "function_call_output") {
      const list = this.pending.get(id);
      this.pending.delete(id);
      const at = timestampMs(r.timestamp);
      if (list && str(p, "output").trim() === "Plan updated" && at !== null) return list.stamped(at * 1000);
    }
    return null;
  }
}
