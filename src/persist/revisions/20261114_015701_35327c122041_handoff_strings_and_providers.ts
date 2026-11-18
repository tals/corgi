import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "35327c122041",
  parent: "3721a7d79310",
  description: "Normalize handoff strings and provider maps",
  up(value) {
    const summaries = values.object(value).summaries;
    if (summaries !== undefined && summaries !== null) {
      const fields = values.object(summaries);
      if ("launches" in fields) {
        const launches = values.object(fields.launches);
        if ("count" in launches) {
          const count = values.object(launches.count);
          if (!("values" in count)) throw Error("InvalidCheckpoint");
          launches.count = count.values;
          values.byProvider(launches, "count", "integer");
        }
      }
      for (const entry of values.items(summaries, "slots"))
        if ("slot" in values.object(entry)) values.slotText(entry.slot);
      for (const result of values.items(summaries, "link_results"))
        if (result !== null) values.wrapped(values.object(result), "name");
    }
    for (const client of values.items(value, "clients")) {
      const saved = values.object(client).launch_preview;
      if (saved === undefined || saved === null) continue;
      const fields = values.object(saved);
      values.paired(fields, "cwd", "len");
      if (!("preview" in fields)) continue;
      for (const option of values.items(fields.preview, "options"))
        for (const key of ["model", "source", "account", "plan", "usage_error"])
          values.wrapped(values.object(option), key);
      values.byProvider(fields.preview, "options", "object");
      values.byProvider(fields.preview, "installed", "boolean");
    }
    return value;
  },
  down: null,
};
