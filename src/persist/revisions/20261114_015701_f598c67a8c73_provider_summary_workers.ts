import type { Revision } from "../formats";
import * as values from "../revision_values";

export const revision: Revision = {
  id: "f598c67a8c73",
  parent: "35327c122041",
  description: "Store summary workers in provider clients",
  up(value) {
    const summaries = values.object(value).summaries;
    if (summaries === undefined || summaries === null || !("pool" in values.object(summaries))) return value;
    const pool = values.object(summaries.pool),
      config = values.object(pool.config ?? {});
    for (const slot of values.items(pool, "slots")) {
      if (slot === null) continue;
      const fields = values.object(slot),
        schema = fields.schema ?? null;
      values.client(fields, {
        ready: true,
        cwd: "/tmp",
        next_id: fields.next_id ?? 1,
        thread: fields.thread ?? "",
        created: fields.conversations_created ?? 0,
        summary:
          config.provider === "claude"
            ? { schema: schema !== null }
            : { instructions: fields.instructions ?? "", model: config.model ?? null, schema },
      });
      for (const key of [
        "exited",
        "ready",
        "events",
        "next_seq",
        "cursor",
        "next_id",
        "thread",
        "conversations_created",
        "usage_cursor",
      ])
        delete fields[key];
    }
    return value;
  },
  down: null,
};
