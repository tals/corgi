import type { Revision } from "../formats";

export const revision: Revision = {
  id: "e4d557bcd1e4",
  parent: "e2a57d17f66f",
  description: "Separate current recovery metadata from legacy checkpoints",
  up: value => value,
  down: value => value,
};
