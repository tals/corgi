import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "5164afe07e1f",
  parent: "e853a6493fda",
  description: "Group provider launch counts",
  up(value) {
    const summaries = values.object(value).summaries;
    if (summaries === undefined || summaries === null) return value;
    const launches = values.object(summaries).launches;
    if (launches === undefined) return value;
    const fields = values.object(launches);
    if (!("count" in fields)) fields.count = { values: [fields.codex ?? 0, fields.claude ?? 0] };
    delete fields.codex;
    delete fields.claude;
    return value;
  },
  down: null,
};
