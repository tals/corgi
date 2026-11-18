import type { Revision } from "../formats";

export const revision: Revision = {
  id: "726fa383fd91",
  parent: "e4d557bcd1e4",
  description: "Add remote account management and model lookup RPCs",
  // RPC additions leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
