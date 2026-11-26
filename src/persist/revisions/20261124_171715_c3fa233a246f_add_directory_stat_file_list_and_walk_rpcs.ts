import type { Revision } from "../formats";

export const revision: Revision = {
  id: "c3fa233a246f",
  parent: "428273850636",
  description: "Add directory stat, file list and walk RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
