import type { Revision } from "../formats";

export const revision: Revision = {
  id: "c9f65235800c",
  parent: "428273850636",
  description: "Add long-term plans to activity summaries and conversations",
  // Older state has no plans and starts collecting them; older readers ignore them.
  up: value => value,
  down: value => value,
};
