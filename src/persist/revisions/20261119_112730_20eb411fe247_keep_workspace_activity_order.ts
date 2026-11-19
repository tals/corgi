import type { Revision } from "../formats";

export const revision: Revision = {
  id: "20eb411fe247",
  parent: "c52d95a61ae4",
  description: "Keep workspace activity order",
  // Workspace activity fields and auto_order are optional: restore defaults
  // them when missing and older daemons ignore them, so metadata passes as is.
  up: value => value,
  down: value => value,
};
