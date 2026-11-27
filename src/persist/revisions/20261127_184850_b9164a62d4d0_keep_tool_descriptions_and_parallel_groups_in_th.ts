import type { Revision } from "../formats";

export const revision: Revision = {
  id: "b9164a62d4d0",
  parent: "c9f65235800c",
  description: "Keep tool descriptions and parallel groups in the activity plan",
  // Older plans start with an empty tool history. Older readers ignore the added fields.
  up: value => value,
  down: value => value,
};
