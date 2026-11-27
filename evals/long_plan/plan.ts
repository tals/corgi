import * as history from "./history";
import type { History, Tokens } from "./history";
import type { State } from "../../src/activity/plan";
import * as roadmap from "../../src/activity/roadmap";
import { foreground } from "../../src/activity/plan";
export * from "../../src/activity/plan";

export function ledger(state: State, data: History, throughLine = Infinity) {
  const counts: Record<string, Tokens> = Object.fromEntries(state.nodes.map(n => [n.id, history.zero()]));
  let observed = history.zero(),
    unattributed = history.zero();
  const parents = new Map(state.nodes.map(n => [n.id, n.parent]));
  for (const receipt of data.receipts) {
    if (receipt.line > throughLine) continue;
    observed = history.add(observed, receipt.tokens);
    let id =
      receipt.event === null ? null : state.spans.find(s => s.from <= receipt.event! && s.to >= receipt.event!)?.node;
    if (!id) unattributed = history.add(unattributed, receipt.tokens);
    while (id) {
      counts[id] = history.add(counts[id], receipt.tokens);
      id = parents.get(id);
    }
  }
  return { counts, observed, unattributed, known: data.receipts.some(receipt => receipt.line <= throughLine) };
}

/** Replay the same visits as live Corgi, with receipts kept on their generating visit. */
export function snapshot(state: State, data: History, throughLine = Infinity): roadmap.Snapshot {
  const book = ledger(state, data, throughLine),
    attention = foreground(state.spans, data.events),
    visits = roadmap.appendVisits([], attention),
    counts: Record<string, roadmap.Counts> = Object.fromEntries(
      state.nodes.map(n => [n.id, { ...book.counts[n.id], tools: "0" }]),
    ),
    parents = new Map(state.nodes.map(n => [n.id, n.parent]));
  const assigned = (event: number | null) =>
    event === null ? null : (state.spans.find(s => s.from <= event && event <= s.to)?.node ?? null);
  for (const receipt of data.receipts) {
    if (receipt.line > throughLine) continue;
    const step = assigned(receipt.event),
      visit = step === null ? undefined : roadmap.visitAt(visits, step, receipt.event!);
    if (visit) visit.counts = roadmap.add(visit.counts, { ...receipt.tokens, tools: "0" });
  }
  let unassignedTools = 0n;
  for (const event of data.events) {
    if (event.id > state.through || event.line > throughLine || (event.kind !== "tool" && event.kind !== "plan"))
      continue;
    let id = assigned(event.id);
    const visit = id ? roadmap.visitAt(visits, id, event.id) : undefined;
    if (visit) visit.counts.tools = String(BigInt(visit.counts.tools!) + 1n);
    if (!id) unassignedTools++;
    while (id) {
      counts[id].tools = String(BigInt(counts[id].tools!) + 1n);
      id = parents.get(id) ?? null;
    }
  }
  return {
    nodes: state.nodes,
    visits,
    focus: roadmap.focusEpisode(state.nodes, attention),
    focus_step: roadmap.focusStep(attention),
    counts,
    unassigned: { ...book.unattributed, tools: String(unassignedTools) },
    known: book.known,
    partial: data.warnings.length > 0,
    limited: false,
  };
}
