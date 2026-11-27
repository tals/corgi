import type { Revision } from "../formats";

export const revision: Revision = {
  id: "069d01d2bd60",
  parent: "b9164a62d4d0",
  description: "Remember activity tool outcomes and completed call summaries",
  // New readers keep older calls neutral when there is no recorded outcome.
  up: value => value,
  down: value => value,
};
