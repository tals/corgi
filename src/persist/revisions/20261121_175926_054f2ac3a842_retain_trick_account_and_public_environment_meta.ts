import type { Revision } from "../formats";

export const revision: Revision = {
  id: "054f2ac3a842",
  parent: "1047006f32d4",
  description: "Retain Trick account and public environment metadata",
  // Added metadata has restore defaults; older readers ignore it.
  up: value => value,
  down: value => value,
};
