import type { Revision } from "../formats";

export const revision: Revision = {
  id: "4d1f556f7e8b",
  parent: "069d01d2bd60",
  description: "Keep tool calls with their starting step or request",
  up: value => value,
  down: value => value,
};
