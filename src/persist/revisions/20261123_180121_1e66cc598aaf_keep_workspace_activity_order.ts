import type { Revision } from "../formats";

export const revision: Revision = {
  id: "1e66cc598aaf",
  parent: "1047006f32d4",
  description: "Keep workspace activity order",
  // Workspace activity fields and auto_order are optional: restore defaults
  // them when missing and older daemons ignore them, so metadata passes as is.
  up: value => value,
  down: value => value,
};
