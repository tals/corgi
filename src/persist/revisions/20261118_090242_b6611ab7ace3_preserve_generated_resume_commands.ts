import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "b6611ab7ace3",
  parent: "ce6d04179c29",
  description: "Preserve generated resume commands",
  up: value => value,
  down(value) {
    if (value === null) return null;
    const runtime = values.object(values.object(value).runtime);
    for (const pane of [...values.items(runtime, "panes"), ...values.items(runtime, "closed")]) {
      const fields = values.object(pane);
      if (fields.launch && oversized(values.object(fields.launch).command)) fields.launch = null;
      for (const key of ["manual_command", "recovery_command"]) if (oversized(fields[key])) fields[key] = null;
    }
    return value;
  },
};

function oversized(value: unknown): boolean {
  return typeof value === "string" && Buffer.byteLength(value) > 2048;
}
