import type { FileHandle } from "node:fs/promises";
import type { Transcript } from "../adapter";
import { field, str, Text } from "../common";
import { Counts } from "../../usage/tokens";
import { Model } from "../model";
import { transcript as pi } from "../pi/transcript";
import * as todos from "../../activity/todos";
import { parse } from "../../json";

function plan(value: unknown): todos.Phase[] | null {
  const message = field(value, "message");
  if (str(value, "type") === "custom" && str(value, "customType") === "user_todo_edit")
    return todos.phases(field(field(value, "data"), "phases"));
  if (
    str(value, "type") === "message" &&
    str(message, "role") === "toolResult" &&
    str(message, "toolName") === "todo" &&
    !field(message, "isError") &&
    str(field(message, "details"), "op") !== "view"
  )
    return todos.phases(field(field(message, "details"), "phases"));
  return null;
}

/** The newest complete snapshot wins, including an explicitly cleared plan. */
async function latestPlan(file: FileHandle, offset: number): Promise<todos.Phase[]> {
  const limit = 1024 * 1024;
  let partial = Buffer.alloc(0),
    complete = false,
    discard = false;
  while (offset > 0) {
    const length = Math.min(offset, 65536),
      bytes = Buffer.alloc(length);
    offset -= length;
    const { bytesRead } = await file.read(bytes, 0, length, offset);
    if (bytesRead !== length) throw Error("UnexpectedEnd");
    const input = partial.length ? Buffer.concat([bytes, partial]) : bytes;
    let end = input.length,
      at = input.lastIndexOf(10);
    while (at >= 0 || offset === 0) {
      if (complete && !discard && end - at - 1 <= limit)
        try {
          const phases = plan(parse(input.subarray(at + 1, end).toString()));
          if (phases !== null) return phases;
        } catch {
          // A malformed record does not supersede a committed plan.
        }
      complete = true;
      discard = false;
      end = at;
      if (at < 0) break;
      at = at > 0 ? input.lastIndexOf(10, at - 1) : -1;
    }
    discard ||= end > limit;
    partial = complete && !discard && end > 0 ? input.subarray(0, end) : Buffer.alloc(0);
  }
  return [];
}

/** Pi's session records, after a title slot omp rewrites in place. omp names
 * its sessions itself, so Corgi doesn't. */
export const transcript: Transcript = {
  verify(head, session) {
    // The title slot comes before the header, and says nothing of the session.
    if (str(head, "type") === "title") return;
    pi.verify!(head, session);
  },
  completion: pi.completion,
  fallback: pi.fallback,
  reader(accounts) {
    const reader = pi.reader(accounts);
    return {
      open(t, req, head, catch_up) {
        reader.open(t, req, head, catch_up);
        if (str(head, "type") === "title") t.name = new Text(str(head, "title").slice(0, 160));
        t.todo_phases = [];
        t.todos_dirty = true;
      },
      async restore(t, file) {
        t.todo_phases = await latestPlan(file, t.initial_until);
        t.todos_dirty = true;
      },
      record(t, req, v, appended, stamp) {
        const phases = plan(v);
        if (phases !== null) {
          t.todo_phases = phases;
          t.todos_dirty = true;
        }
        switch (str(v, "type")) {
          case "title":
          case "title_change": {
            const title = str(v, "title");
            if (title) t.name = new Text(title.slice(0, 160));
            return new Counts();
          }
          case "model_change": {
            const model = str(v, "model");
            if (model) t.model = Model.resolve(model.slice(model.indexOf("/") + 1));
            return new Counts();
          }
          default:
            return reader.record(t, req, v, appended, stamp);
        }
      },
    };
  },
};
