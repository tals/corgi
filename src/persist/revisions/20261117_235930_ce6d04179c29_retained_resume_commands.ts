import type { Revision } from "../formats";

export const revision: Revision = {
  id: "ce6d04179c29",
  parent: "726fa383fd91",
  description: "Distinguish retained resume commands from custom launch commands",
  up: value => value,
  down: value => value,
};
