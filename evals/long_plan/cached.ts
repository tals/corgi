import * as plan from "../../src/activity/plan";
import * as roadmap from "../../src/activity/roadmap";
import type { Request } from "../../src/inference/harness";

const signature = (state: plan.State) => JSON.stringify([state.through, state.nodes]);

/** Retain exact accepted state between updates; reseed on eviction, rejection or divergence. */
export class Conversation {
  previous: roadmap.Input | null = null;
  expected = "";
  key = "";
  turns = 0;
  invalidate() {
    this.previous = null;
  }
  prepare(input: roadmap.Input): Request {
    if (!this.previous || this.expected !== signature(input.state) || this.turns >= 4) {
      this.previous = null;
      this.key = "plan:" + crypto.randomUUID();
      this.turns = 0;
    }
    const fresh = roadmap.content(input);
    let content = fresh;
    if (this.previous) {
      const nodes = new Map(this.previous.state.nodes.map(n => [n.id, JSON.stringify(n)])),
        support = new Map(this.previous.support.map(e => [e.id, JSON.stringify(e)]));
      content = JSON.stringify({
        tree_updates: input.state.nodes.filter(n => nodes.get(n.id) !== JSON.stringify(n)),
        assign_from: input.events[0].id,
        assign_through: input.events.at(-1)!.id,
        support: input.support.filter(e => support.get(e.id) !== JSON.stringify(e)),
        events: input.events,
      });
    }
    return {
      instructions: plan.instructions,
      schema: plan.schema,
      content,
      fresh_content: fresh,
      conversation: this.key,
    };
  }
  accept(input: roadmap.Input, state: plan.State) {
    this.previous = structuredClone(input);
    this.expected = signature(state);
    this.turns++;
  }
}
