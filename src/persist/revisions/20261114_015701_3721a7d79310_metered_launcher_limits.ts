import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "3721a7d79310",
  parent: "5164afe07e1f",
  description: "Replace launcher usage text with metered limits",
  up(value) {
    for (const client of values.items(value, "clients")) {
      const saved = values.object(client).launch_preview;
      if (saved === undefined || saved === null) continue;
      const preview = values.object(saved).preview;
      if (preview === undefined) continue;
      for (const option of values.items(preview, "options")) {
        const fields = values.object(option);
        if (fields.usage_metered === true) fields.limits = { metered: {} };
        delete fields.usage;
        delete fields.usage_metered;
        delete fields.resets;
      }
    }
    return value;
  },
  down: null,
};
