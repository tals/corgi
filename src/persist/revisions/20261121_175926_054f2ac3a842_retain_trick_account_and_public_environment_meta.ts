import type { Revision } from "../formats";

export const revision: Revision = {
  id: "054f2ac3a842",
  parent: "632fb56ecc05",
  description: "Retain Trick account and public environment metadata",
  // Added metadata has restore defaults; older readers ignore it.
  up: value => value,
  down: value => value,
};
