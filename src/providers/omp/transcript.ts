import type { Transcript } from "../adapter";
import { field, str, timestampMs, Text } from "../common";
import { Counts } from "../../usage/tokens";
import { Model } from "../model";
import { transcript as pi } from "../pi/transcript";
import { messageIntent, nativeIntent } from "./headless";
import * as todos from "./todos";

/** Pi's session records, after a title slot omp rewrites in place. omp names
 * its sessions itself, so Corgi doesn't. */
export const transcript: Transcript = {
  verify(head, session) {
    // The title slot comes before the header, and says nothing of the session.
    if (str(head, "type") === "title") return;
    pi.verify!(head, session);
  },
  completion: pi.completion,
  fallback(r, agent) {
    if (r.name.len) agent.setName(r.name.text());
    if (agent.state !== "working" || !r.update.len || r.update_at <= agent.activity_at) return false;
    const changed = agent.activity.text() !== r.update.text();
    agent.setActivity(r.update.text());
    agent.activity_at = r.update_at;
    agent.activity_inferred = false;
    return changed;
  },
  reader(accounts) {
    const reader = pi.reader(accounts);
    return {
      open(t, req, head, catch_up) {
        reader.open(t, req, head, catch_up);
        if (!req.child && str(head, "type") === "title") t.name = new Text(str(head, "title").slice(0, 160));
      },
      record(t, req, v, appended, stamp) {
        const type = str(v, "type"),
          message = field(v, "message"),
          details = field(message, "details"),
          phases =
            type === "custom" && str(v, "customType") === "user_todo_edit"
              ? field(field(v, "data"), "phases")
              : type === "message" &&
                  str(message, "role") === "toolResult" &&
                  str(message, "toolName") === "todo" &&
                  !field(message, "isError") &&
                  str(details, "op") !== "view"
                ? field(details, "phases")
                : null;
        if (Array.isArray(phases) && stamp !== null && stamp * 1000 >= (t.checklist?.at ?? 0))
          t.checklist = todos.parse({ phases }, stamp * 1000);
        switch (str(v, "type")) {
          case "title":
          case "title_change": {
            const title = str(v, "title");
            if (!req.child && title) t.name = new Text(title.slice(0, 160));
            return new Counts();
          }
          case "model_change": {
            const model = str(v, "model");
            if (model) t.model = Model.resolve(model.slice(model.indexOf("/") + 1));
            return new Counts();
          }
          case "message": {
            // Keep Pi's usage and tool evidence, not its assistant-prose label.
            const previous = t.update,
              previousAt = t.update_at,
              delta = reader.record(t, req, v, appended, stamp);
            t.update = previous;
            t.update_at = previousAt;
            const message = field(v, "message"),
              intent = messageIntent(message),
              started = field(message, "timestamp");
            // Assistant messages are persisted at completion; their own timestamp
            // precedes any newer live tool intent received during that message.
            const at =
              stamp === null
                ? null
                : typeof started === "number" && Number.isFinite(started) && started >= 0
                  ? Math.min(stamp, started)
                  : stamp;
            if (intent && at !== null && at * 1000 > t.update_at) {
              t.update = new Text(intent.text);
              t.update_at = at * 1000;
            }
            return delta;
          }
          case "custom": {
            if (str(v, "customType") !== "tool_execution_start") return reader.record(t, req, v, appended, stamp);
            const data = field(v, "data"),
              intent = nativeIntent(field(data, "intent")) || nativeIntent(field(field(data, "args"), "i")),
              started = timestampMs(str(data, "startedAt")),
              at = stamp === null ? started : started === null ? stamp : Math.min(stamp, started);
            if (intent && at !== null && at * 1000 > t.update_at) {
              t.update = new Text(intent);
              t.update_at = at * 1000;
            }
            return new Counts();
          }
          default:
            return reader.record(t, req, v, appended, stamp);
        }
      },
    };
  },
};
