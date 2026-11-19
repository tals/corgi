import type { Revision } from "../formats";

export const revision: Revision = {
  id: "632fb56ecc05",
  parent: "c52d95a61ae4",
  description: "Add review read, diffs, summary and recognize RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
