import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "1dfaa1773956",
  parent: "d58e69e6af6c",
  description: "Store headless process state in provider clients",
  up(value) {
    for (const workspace of values.items(value, "workspaces"))
      for (const target of values.items(workspace, "agent_order")) {
        const fields = values.object(target);
        if (!("native" in fields)) continue;
        fields.headless = fields.native;
        delete fields.native;
      }
    // Headless sessions keep their process; their client reads the requests
    // still waiting from the lines that asked them. The journal of raw lines
    // has no decoded form, so it starts over.
    for (const session of values.items(value, "sessions")) {
      const fields = values.object(session);
      values.client(fields, {
        cwd: fields.cwd ?? "",
        lines: values.items(fields, "approvals"),
        active: values.items(fields, "turns").map(turn => [values.object(turn).thread, values.object(turn).turn]),
      });
      fields.approvals = [];
      delete fields.approval_actors;
      fields.events = [];
      fields.journal_bytes = 0;
    }
    return value;
  },
  down: null,
};
