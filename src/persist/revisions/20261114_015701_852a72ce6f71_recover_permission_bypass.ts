import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "852a72ce6f71",
  parent: "66623983aa75",
  description: "Recover permission bypass from saved command mode",
  up(value) {
    for (const command of values.items(value, "agent_commands")) {
      try {
        const info = values.object(values.object(command).semantics),
          mode = values.object(info.mode);
        if (mode.len === 23 && values.fixedText(mode.bytes, mode.len) === "Skips permission checks") info.yolo = true;
      } catch {}
    }
    return value;
  },
  down: null,
};
