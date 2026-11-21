import type { Revision } from "../formats";

export const revision: Revision = {
  id: "7db8ca3a11e2",
  parent: "632fb56ecc05",
  description: "Add file stat, read, line and count RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
