import type { Revision } from "../formats";

export const revision: Revision = {
  id: "3a7b4081f20a",
  parent: "632fb56ecc05",
  description: "Add file stat, read, line, count and thumbnail RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
