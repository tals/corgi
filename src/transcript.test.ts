import { test, expect } from "bun:test";
import { Registry, Attachment } from "./conversations";
import { Worker } from "./transcript";
import { Path } from "./agents";
test("completion scheduling retains detached actors and fairly batches beyond pane capacity", () => {
  const registry = new Registry(),
    worker = new Worker(),
    attachment = new Attachment();
  for (let i = 0; i < 65; i++) {
    const actor = registry.get("claude", `session-${i}`);
    actor.state.observation.pending_stop = true;
    actor.state.transcript = Path.ascii("/tmp/transcript.jsonl");
    attachment.select(actor);
  }
  attachment.detach();
  worker.reconcile(registry.items);
  expect(worker.requests.length).toBe(65);
  expect(worker.batch()[0].actor).toBe(registry.items[0].id);
  expect(worker.batch()[0].actor).toBe(registry.items[64].id);
  expect(attachment.actor).toBeNull();
  worker.stop();
});
