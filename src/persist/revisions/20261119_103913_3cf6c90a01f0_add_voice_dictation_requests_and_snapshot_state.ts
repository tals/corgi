import type { Revision } from "../formats";

export const revision: Revision = {
  id: "3cf6c90a01f0",
  parent: "c52d95a61ae4",
  description: "Add voice dictation requests and snapshot state",
  // Only the wire gains fields; saved auxiliary state is unchanged.
  up: value => value,
  down: value => value,
};
