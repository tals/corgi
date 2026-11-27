import * as history from "./history";
import * as plan from "./plan";
import type { History } from "./history";
import type { State } from "./plan";
import * as roadmap from "../../src/activity/roadmap";

export type Check =
  | { name: string; kind: "focus"; event: number; target: number; level: "step" | "episode" }
  | { name: string; kind: "planned_step"; pattern: string }
  | { name: string; kind: "planned_only" }
  | {
      name: string;
      kind: "bump";
      event: number;
      category: plan.BumpKind | null;
      state?: "open" | "resolved";
      at?: number;
    }
  | { name: string; kind: "bump_count"; count: number }
  | { name: string; kind: "no_bump_started"; from: number; to: number }
  | { name: string; kind: "same_episode" | "different_episode"; a: number; b: number }
  | {
      name: string;
      kind: "topic" | "subtitle" | "label";
      event: number;
      level: "episode" | "step";
      pattern: string;
      at?: number;
    }
  | {
      name: string;
      kind: "state";
      event: number;
      level: "episode" | "step";
      state: plan.Node["state"];
      at: number;
    };
export type Result = { name: string; pass: boolean; detail: string };
export function ancestor(state: State, event: number, level: plan.Node["kind"]) {
  const id = state.spans.find(s => s.from <= event && s.to >= event)?.node;
  let node = state.nodes.find(n => n.id === id);
  while (node && node.kind !== level) node = state.nodes.find(n => n.id === node!.parent);
  return node;
}
export function score(data: History, snapshots: State[], checks: Check[]): Result[] {
  const state = snapshots.at(-1) ?? plan.empty(),
    tokens = plan.ledger(state, data);
  const rootTotal = state.nodes
    .filter(n => n.parent === null)
    .reduce((n, root) => history.add(n, tokens.counts[root.id]), tokens.unattributed);
  const result: Result[] = [
    {
      name: "complete replay",
      pass: state.through === data.events.length,
      detail: `${state.through}/${data.events.length} events`,
    },
    {
      name: "token conservation",
      pass: JSON.stringify(rootTotal) === JSON.stringify(tokens.observed),
      detail: `${history.total(tokens.observed)} observed; ${history.total(tokens.unattributed)} unattributed`,
    },
  ];
  const contradictory = snapshots.flatMap(snapshot =>
    snapshot.nodes.filter(
      node =>
        node.state === "done" &&
        snapshot.nodes.some(
          child => child.parent === node.id && ["active", "planned", "blocked"].includes(child.state),
        ),
    ),
  );
  result.push({
    name: "parent completion agrees with children",
    pass: contradictory.length === 0,
    detail: `${contradictory.length} completed parents with unfinished children`,
  });
  for (const check of checks) {
    let pass = false,
      detail = "";
    switch (check.kind) {
      case "focus": {
        const expected = ancestor(state, check.target, check.level);
        const id = roadmap.focusStep(plan.foreground(state.spans, data.events).filter(s => s.from <= check.event));
        let actual = state.nodes.find(n => n.id === id);
        if (check.level === "episode") actual = state.nodes.find(n => n.id === actual?.parent);
        pass = Boolean(expected && actual && expected.id === actual.id);
        detail = `${actual?.title ?? "no focus"}; expected ${expected?.title ?? "unassigned"}`;
        break;
      }
      case "planned_step": {
        const nodes = state.nodes.filter(n => n.kind === "step" && n.state === "planned");
        pass = nodes.some(n => new RegExp(check.pattern, "i").test(n.title + " " + n.subtitle));
        detail = nodes.map(n => n.title).join(" / ") || "no planned steps";
        break;
      }
      case "planned_only": {
        pass =
          state.nodes.length > 0 &&
          state.nodes.every(n => n.state === "planned") &&
          state.spans.every(s => s.node === null);
        detail = `${state.nodes.length} intended nodes; ${state.spans.filter(s => s.node !== null).length} work spans`;
        break;
      }
      case "bump": {
        const snapshot = check.at === undefined ? state : snapshots.find(s => s.through >= check.at!);
        const node = snapshot && ancestor(snapshot, check.event, "step");
        detail = node?.bump
          ? `${node.bump.kind}: ${node.bump.state} — ${node.bump.detail}`
          : node
            ? `no bump on ${node.title}`
            : `event ${check.event} is unassigned`;
        pass =
          check.category === null
            ? !node?.bump
            : node?.bump?.kind === check.category && (!check.state || node.bump.state === check.state);
        break;
      }
      case "bump_count": {
        const count = state.nodes.filter(n => n.bump).length;
        pass = count === check.count;
        detail = `${count} bumps`;
        break;
      }
      case "no_bump_started": {
        const invented = state.nodes.filter(
          n => n.bump && n.bump.evidence[0] >= check.from && n.bump.evidence[0] <= check.to,
        );
        pass = invented.length === 0;
        detail = invented.map(n => n.bump!.detail).join("; ") || "no setback starts in this evidence range";
        break;
      }
      case "same_episode":
      case "different_episode": {
        const a = ancestor(state, check.a, "episode"),
          b = ancestor(state, check.b, "episode");
        pass = !!a && !!b && (check.kind === "different_episode" ? a.id !== b.id : a.id === b.id);
        detail = `${a?.title ?? "unassigned"} / ${b?.title ?? "unassigned"}`;
        break;
      }
      case "topic":
      case "subtitle":
      case "label": {
        const prefix = check.at === undefined ? state : snapshots.find(s => s.through >= check.at!);
        const node = prefix && ancestor(prefix, check.event, check.level);
        detail = node
          ? check.kind === "label"
            ? `${node.title}: ${node.subtitle}`
            : check.kind === "topic"
              ? node.title
              : node.subtitle
          : "unassigned";
        pass = !!node && new RegExp(check.pattern, "i").test(detail);
        break;
      }
      case "state": {
        const snapshot = snapshots.find(s => s.through >= check.at),
          node = snapshot && ancestor(snapshot, check.event, check.level);
        detail = `${node?.state ?? "unassigned"} at first checkpoint >= ${check.at}`;
        pass = node?.state === check.state;
        break;
      }
    }
    result.push({ name: check.name, pass, detail });
  }
  return result;
}
export function metrics(data: History, snapshots: State[]) {
  let oldTitles = 0,
    changedTitles = 0,
    closedRewrites = 0;
  for (let i = 1; i < snapshots.length; i++) {
    for (const before of snapshots[i - 1].nodes) {
      const after = snapshots[i].nodes.find(n => n.id === before.id);
      oldTitles++;
      if (after?.title !== before.title) changedTitles++;
      if (
        ["done", "abandoned"].includes(before.state) &&
        after &&
        (after.title !== before.title || after.subtitle !== before.subtitle)
      )
        closedRewrites++;
    }
  }
  const final = snapshots.at(-1) ?? plan.empty();
  const tokens = plan.ledger(final, data);
  return {
    events: data.events.length,
    tools: data.events.filter(e => e.kind === "tool").length,
    goals: 0,
    episodes: final.nodes.filter(n => n.kind === "episode").length,
    steps: final.nodes.filter(n => n.kind === "step").length,
    title_changes: changedTitles,
    title_opportunities: oldTitles,
    closed_rewrites: closedRewrites,
    attributed_token_fraction: history.total(tokens.observed)
      ? Number(history.total(tokens.observed) - history.total(tokens.unattributed)) /
        Number(history.total(tokens.observed))
      : null,
  };
}
