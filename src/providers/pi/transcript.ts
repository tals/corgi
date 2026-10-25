import type { Transcript } from "../adapter";
import { field, str, number, Text } from "../common";
import { Counts } from "../../usage/tokens";
import { Tokens } from "../../usage/live";
import { Model } from "../model";
import { Call, clip, shortPath } from "../../activity/tools";
import { Text as Summary } from "../../activity/summary";
import { messageText, reported } from "./headless";
export const transcript: Transcript = {
  naming: agent => import("./naming").then(m => m.input(agent)),
  verify(head, session) {
    if (str(head, "type") !== "session" || str(head, "id") !== session) throw Error("WrongSession");
  },
  completion(agent, v) {
    if (str(v, "type") !== "custom" || str(v, "customType") !== "corgi-settled") return null;
    const data = field(v, "data"),
      outcome = str(data, "outcome");
    return str(data, "session") === agent.sessionId() &&
      str(data, "turn") === agent.turnId() &&
      ["completed", "interrupted", "failed"].includes(outcome)
      ? (outcome as "completed" | "interrupted" | "failed")
      : null;
  },
  fallback(r, agent) {
    if (r.name.len) agent.setName(r.name.text());
    if (agent.state === "working" && !agent.activity_inferred && r.update.len && r.update_at > agent.activity_at) {
      agent.setActivity(r.update.text());
      agent.activity_at = r.update_at;
    }
    // Hooks can outrank the fallback label without replacing summary evidence.
    const p = r.progress;
    if (
      !p ||
      agent.state !== "working" ||
      p.ended ||
      !p.turn.len ||
      agent.turnId() !== p.turn.text() ||
      (!p.commentary.len && !p.evidence.len)
    )
      return false;
    agent.activity_generation = Bun.hash.wyhash(agent.turnId(), 0n);
    return true;
  },
  reader: () => ({
    open(t, _req, _head, catch_up) {
      t.catch_up = catch_up;
      t.live.meter.count(0n, 0n);
    },
    record(t, req, v, appended, stamp) {
      const type = str(v, "type"),
        m = field(v, "message"),
        role = str(m, "role"),
        id = str(v, "id");
      const delta = new Counts();
      if (type === "session_info") t.name = new Text(str(v, "name").slice(0, 160));
      if (type === "model_change") t.model = Model.resolve(str(v, "modelId"));
      if (type === "custom" && str(v, "customType") === "corgi-context") {
        const data = field(v, "data"),
          used = number(data, "used"),
          window = number(data, "window");
        if (used !== null && window !== null && stamp !== null) {
          t.context.used = used;
          t.context.window = window;
          t.context.at = stamp;
          t.context.model = Model.resolve(str(data, "model"));
        }
      }
      if (type !== "message") return delta;
      if (role === "user" || role === "assistant") t.spoke_at = Math.max(t.spoke_at, stamp ?? 0);
      if (role === "assistant") {
        const model = str(m, "model");
        if (model) t.model = Model.resolve(model);
        const tokens = reported(field(m, "usage"));
        if (tokens && id)
          delta.add(t.tracker.tokensCached(id, tokens.input, tokens.cached_input, tokens.output, false));
        delta.turns = t.tracker.response(id);
        const text = messageText(m).trim();
        if (text && stamp !== null) {
          t.update = new Text(clip(text, 160));
          t.update_at = stamp * 1000;
        }
        const content = field(m, "content");
        for (const b of Array.isArray(content) ? content : []) {
          if (str(b, "type") === "toolCall") {
            const id = str(b, "id");
            delta.tools += t.tracker.tool(id);
            if (appended && t.progress.turn.len) {
              const call = new Call();
              call.id = t.progress.key(id);
              call.append(str(b, "name") + ": ");
              const args = field(b, "arguments");
              call.detail(str(args, "command") || shortPath(str(args, "path")));
              t.progress.save(call, true);
            }
          }
        }
        if (appended || (t.catch_up && stamp !== null && stamp >= req.tracked_since)) {
          t.live.meter.count(delta.turns, delta.tools);
          if (delta.tokens_known)
            t.live.meter.add(
              new Tokens({ input: delta.input, cached_input: delta.cached_input, output: delta.output }),
              stamp ?? Date.now(),
            );
        }
        if (appended && text && t.progress.turn.len) {
          t.progress.commentary = new Summary(clip("Latest agent update: " + text, 2048));
          t.progress.dirty = true;
        }
      } else if (role === "toolResult" && appended) t.progress.finishId(t.progress.key(str(m, "toolCallId")), true);
      return delta;
    },
  }),
};
