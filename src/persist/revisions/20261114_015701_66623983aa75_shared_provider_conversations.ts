import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "66623983aa75",
  parent: "e6040f3691c4",
  description: "Promote provider sessions into shared conversations",
  up(value) {
    for (const collection of ["panes", "sessions"])
      for (const entry of values.items(value, collection)) {
        if (collection === "panes") values.optionalProvider(entry, "agent");
        values.optionalProvider(entry, "resume_hint");
        if (entry.binding !== undefined && entry.binding !== null)
          values.optionalProvider(entry.binding, "provisional");
      }
    for (const actor of values.items(value, "conversations")) values.optionalProvider(actor, "agent");
    for (const command of values.items(value, "agent_commands")) values.optionalProvider(command, "semantics");
    values.promote(value);
    return value;
  },
  down: null,
};
