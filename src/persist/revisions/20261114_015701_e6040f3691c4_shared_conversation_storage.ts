import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "e6040f3691c4",
  parent: "f02a7f1348ba",
  description: "Add shared conversation storage",
  up(value) {
    const fields = values.object(value);
    if (!("conversations" in fields)) fields.conversations = [];
    if (!("next_conversation" in fields)) fields.next_conversation = 1;
    return value;
  },
  down: null,
};
