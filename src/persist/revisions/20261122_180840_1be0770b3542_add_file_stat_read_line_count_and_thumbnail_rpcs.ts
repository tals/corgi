import type { Revision } from "../formats";

export const revision: Revision = {
  id: "1be0770b3542",
  parent: "632fb56ecc05",
  description: "Add file stat, read, line, count and thumbnail RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
