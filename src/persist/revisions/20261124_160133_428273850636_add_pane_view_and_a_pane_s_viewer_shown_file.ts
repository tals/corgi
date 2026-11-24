import type { Revision } from "../formats";

export const revision: Revision = {
  id: "428273850636",
  parent: "531e30a41925",
  description: "Add pane.view and a pane's viewer-shown file",
  // An RPC and a snapshot field leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
