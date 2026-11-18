import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "d58e69e6af6c",
  parent: "852a72ce6f71",
  description: "Replace fixed byte strings and index providers by name",
  up(value) {
    for (const actor of values.items(value, "conversations")) {
      const fields = values.object(actor);
      if ("agent" in fields) values.agentText(fields.agent);
      if ("status_inference" in fields) values.recentText(fields.status_inference);
    }
    for (const collection of ["panes", "sessions"])
      for (const entry of values.items(value, collection)) {
        const fields = values.object(entry);
        if (fields.binding !== undefined && fields.binding !== null) {
          const binding = values.object(fields.binding);
          if ("provisional" in binding) values.agentText(binding.provisional);
        }
        if ("resume_hint" in fields) {
          const hint = values.object(fields.resume_hint);
          values.paired(hint, "name", "name_len");
          values.paired(hint, "session", "len");
        }
      }
    for (const pane of values.items(value, "panes")) {
      delete values.object(pane).agent;
      values.wrapped(pane, "label");
    }
    for (const pane of values.items(value, "closed")) values.wrapped(values.object(pane), "label");
    if ("link_labels" in values.object(value))
      for (const entry of values.items(values.object(value).link_labels, "entries"))
        if (entry !== null) values.wrapped(values.object(entry), "name");
    for (const command of values.items(value, "agent_commands")) {
      const fields = values.object(command);
      values.paired(fields, "bytes", "len");
      if ("bytes" in fields) {
        fields.command = fields.bytes;
        delete fields.bytes;
      }
      values.paired(fields, "original", "original_len");
      values.wrapped(fields, "name");
      if ("semantics" in fields)
        for (const key of ["suggested_name", "model", "account", "mode"])
          values.wrapped(values.object(fields.semantics), key);
    }
    values.byProvider(value, "agent_yolo", "boolean");
    values.byProvider(value, "agent_hidden", "boolean");
    return value;
  },
  down: null,
};
