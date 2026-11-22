import type { Revision } from "../formats";

export const revision: Revision = {
  id: "3d0002531f1c",
  parent: "632fb56ecc05",
  description: "Add file stat, read, count, scan, thumbnail, job and handoff RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
