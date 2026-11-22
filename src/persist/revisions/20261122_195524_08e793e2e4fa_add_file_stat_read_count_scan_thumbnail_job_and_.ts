import type { Revision } from "../formats";

export const revision: Revision = {
  id: "08e793e2e4fa",
  parent: "632fb56ecc05",
  description: "Add file stat, read, count, scan, thumbnail, job and handoff RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
