import type { Revision } from "../formats";

export const revision: Revision = {
  id: "531e30a41925",
  parent: "1047006f32d4",
  description: "Keep announced ports through a live handoff",
  // Older checkpoints have none, and older readers ignore them.
  up: value => value,
  down: value => value,
};
