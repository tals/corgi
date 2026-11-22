import type { Revision } from "../formats";

export const revision: Revision = {
  id: "1047006f32d4",
  parent: "08e793e2e4fa",
  description: "Add folder list, find and open RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
