import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "f4c12b1642bd",
  parent: "3cb5c87815a8",
  description: "Remove workspace pinned flag",
  up(value) {
    for (const workspace of values.items(value, "workspaces")) delete values.object(workspace).pinned;
    return value;
  },
  down: null,
};
