import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "38dc0fb4d7d7",
  parent: "f598c67a8c73",
  description: "Reset spend history when changing to cumulative totals",
  up(value) {
    // Spend cells held their own days' spend; now they hold the month's so far.
    for (const client of values.items(value, "clients")) {
      const saved = values.object(client).launch_preview;
      if (saved === undefined || saved === null) continue;
      const preview = values.object(saved).preview;
      if (preview === undefined) continue;
      const options = values.object(preview).options;
      if (options === undefined) continue;
      for (const option of Object.values(values.object(options)))
        for (const cell of values.items(option, "spend_history")) values.object(cell).minor = null;
    }
    return value;
  },
  down: null,
};
