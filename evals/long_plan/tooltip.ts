import * as tooltip from "../../src/subagent_tooltip";
import * as roadmap from "../../src/activity/roadmap";
import * as sidebar from "../../src/sidebar";
import type { Writer } from "../../src/text";

/** Show replay accounting through the actual agent tooltip. */
export function draw(
  w: Writer,
  cols: number,
  rows: number,
  name: string,
  provider: string,
  view: roadmap.Snapshot,
  running: boolean | null,
) {
  const total = view.nodes
      .filter(n => n.parent === null)
      .reduce((sum, n) => roadmap.add(sum, view.counts[n.id] ?? roadmap.zero()), view.unassigned),
    state = running === false ? "idle" : "working",
    root = tooltip.conversation({
      id: 1,
      agent: { provider, name, state, session: "replay" },
      activity_plan: view,
      usage: {
        known: view.known,
        partial: view.partial,
        tools: total.tools ?? "0",
        tokens: { input: total.input, cached_input: total.cached, output: total.output },
      },
    }),
    entry = sidebar.entry({ conversation: 1, provider: root.agent.provider, name, state, target: { pane: 1 } });
  return tooltip.draw(w, [root], entry, cols, rows, 0, 0);
}
