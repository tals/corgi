import type { Revision } from "../formats";

export const revision: Revision = {
  id: "904e5f6a3ee6",
  parent: "428273850636",
  description: "Retain Trick account and public environment metadata",
  // Added metadata has restore defaults; older readers ignore it.
  up: value => value,
  down: value => value,
};
