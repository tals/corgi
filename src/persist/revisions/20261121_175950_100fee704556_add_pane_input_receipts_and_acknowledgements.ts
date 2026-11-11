import type { Revision } from "../formats";

export const revision: Revision = {
  id: "100fee704556",
  parent: "632fb56ecc05",
  description: "Add pane input receipts and acknowledgements",
  // Optional wire fields leave saved metadata unchanged.
  up: value => value,
  down: value => value,
};
