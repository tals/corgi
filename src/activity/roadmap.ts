import * as plan from "./plan";
import * as checklist from "./checklist";
import { clip, type Observation } from "./tools";
import * as plan_tools from "./plan_tools";
import type { View } from "../usage/live";

export type Counts = { input: string; cached: string; output: string; tools?: string };
export type Visit = { step: string; from: number; to: number; counts: Counts };
export type Input = {
  state: plan.State;
  events: plan.Event[];
  support: plan.Event[];
  focus?: string | null;
  tools?: plan_tools.Input[];
  /** The conversation's title, attached for inference only; never saved. */
  conversation?: string;
};
export type Snapshot = {
  tool_rows?: plan_tools.Row[];
  nodes: plan.Node[];
  visits: Visit[];
  focus: string | null;
  focus_step: string | null;
  counts: Record<string, Counts>;
  unassigned: Counts;
  known: boolean;
  partial: boolean;
  limited: boolean;
};
export const zero = (): Counts => ({ input: "0", cached: "0", output: "0", tools: "0" });
export const total = (t: Counts) => BigInt(t.input) + BigInt(t.output);
export function add(a: Counts, b: Counts): Counts {
  return {
    input: String(BigInt(a.input) + BigInt(b.input)),
    cached: String(BigInt(a.cached) + BigInt(b.cached)),
    output: String(BigInt(a.output) + BigInt(b.output)),
    tools: a.tools === undefined || b.tools === undefined ? undefined : String(BigInt(a.tools) + BigInt(b.tools)),
  };
}
export function content(input: Input) {
  return JSON.stringify({
    tree: input.state.nodes,
    assign_from: input.events[0].id,
    assign_through: input.events.at(-1)!.id,
    support: input.support,
    events: input.events,
  });
}
export const emptyView = (): Snapshot => ({
  nodes: [],
  visits: [],
  tool_rows: [],
  focus: null,
  focus_step: null,
  counts: {},
  unassigned: zero(),
  known: false,
  partial: true,
  limited: false,
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
function counts(value: unknown): Counts {
  const v = object(value);
  for (const key of ["input", "cached", "output"] as const)
    if (typeof v[key] !== "string" || !/^\d{1,40}$/.test(v[key])) throw Error("InvalidPlanUsage");
  if (v.tools !== undefined && (typeof v.tools !== "string" || !/^\d{1,40}$/.test(v.tools)))
    throw Error("InvalidPlanUsage");
  const out = v as Counts;
  if (BigInt(out.cached) > BigInt(out.input)) throw Error("InvalidPlanUsage");
  return out;
}
export function decode(value: unknown): Snapshot {
  if (value === undefined) return emptyView();
  const v = object(value);
  if (
    !Array.isArray(v.nodes) ||
    v.nodes.length > 256 ||
    typeof v.known !== "boolean" ||
    typeof v.partial !== "boolean" ||
    typeof v.limited !== "boolean"
  )
    throw Error("InvalidRoadmap");
  const through = Math.max(
    1,
    ...v.nodes.flatMap(n => {
      const node = object(n);
      return [
        ...(Array.isArray(node.evidence) ? node.evidence : []),
        ...(Array.isArray(object(node.bump).evidence) ? (object(node.bump).evidence as number[]) : []),
      ].filter(x => typeof x === "number");
    }),
  );
  if (!Number.isSafeInteger(through)) throw Error("InvalidRoadmap");
  const nodes = plan.apply(
    plan.empty(),
    JSON.stringify({ nodes: plan.flatten(v.nodes), spans: [{ from: 1, to: through, node: null }] }),
    [
      { id: 1, line: 1, at: "", turn: 0, kind: "lifecycle", text: "" },
      ...(through > 1 ? [{ id: through, line: through, at: "", turn: 0, kind: "lifecycle" as const, text: "" }] : []),
    ],
  ).state.nodes;
  const ledger = object(v.counts);
  const focus = v.focus ?? null,
    step = v.focus_step ?? null;
  if (focus !== null && !nodes.some(n => n.id === focus && n.kind === "episode")) throw Error("InvalidRoadmap");
  if (step !== null && !nodes.some(n => n.id === step && n.kind === "step" && n.parent === focus))
    throw Error("InvalidRoadmap");
  const visits =
    v.visits ??
    nodes
      .filter(n => n.kind === "step" && n.state !== "planned")
      .map(n => ({
        step: n.id,
        from: 0,
        to: 0,
        counts: ledger[n.id],
      }));
  if (!Array.isArray(visits) || visits.length > 4096) throw Error("InvalidRoadmap");
  let end = 0;
  const decoded = visits.map(value => {
    const visit = object(value);
    if (
      !nodes.some(n => n.id === visit.step && n.kind === "step") ||
      !Number.isSafeInteger(visit.from) ||
      !Number.isSafeInteger(visit.to) ||
      Number(visit.from) < 0 ||
      Number(visit.to) < Number(visit.from) ||
      (visit.from === 0 ? visit.to !== 0 || end !== 0 : Number(visit.from) <= end)
    )
      throw Error("InvalidRoadmap");
    end = Number(visit.to);
    return { step: String(visit.step), from: Number(visit.from), to: end, counts: counts(visit.counts) };
  });
  return {
    nodes,
    tool_rows: plan_tools.decodeRows(v.tool_rows),
    visits: decoded,
    focus: focus as string | null,
    focus_step: step as string | null,
    counts: Object.fromEntries(nodes.map(n => [n.id, counts(ledger[n.id])])),
    unassigned: counts(v.unassigned),
    known: v.known,
    partial: v.partial,
    limited: v.limited,
  };
}

/** Foreground work determines focus; late results only update attribution. */
export function focusStep(spans: plan.Span[], previous: string | null = null): string | null {
  return spans.findLast(s => s.node !== null && s.focus !== false)?.node ?? previous;
}
export function focusEpisode(nodes: plan.Node[], spans: plan.Span[], previous: string | null = null): string | null {
  const id = focusStep(spans),
    step = nodes.find(n => n.id === id && n.kind === "step");
  return step?.parent ?? previous;
}

/** Consecutive work stays together; returning after other work starts a new visit. */
export function appendVisits(previous: Visit[], spans: plan.Span[]): Visit[] {
  const visits = previous.map(v => ({ ...v }));
  for (const span of spans) {
    if (span.node === null) continue;
    if (span.focus === false && visits.some(v => v.step === span.node)) continue;
    const last = visits.at(-1);
    if (last?.step === span.node && last.to > 0) last.to = span.to;
    else visits.push({ step: span.node, from: span.from, to: span.to, counts: zero() });
  }
  return visits;
}
export function visitAt(visits: Visit[], step: string, event: number) {
  return visits.findLast(v => v.step === step && v.from <= event);
}

/** Observed intervals only. The first sample is a baseline, never historical cost assigned to new work. */
export class Roadmap {
  tools = new plan_tools.Ledger();
  state = plan.empty();
  visits: Visit[] = [];
  focus: string | null = null;
  focus_step: string | null = null;
  pending: plan.Event[] = [];
  support: plan.Event[] = [];
  receipts: { event: number; tokens: Counts }[] = [];
  counts: Record<string, Counts> = Object.create(null);
  unassigned = zero();
  baseline: Counts | null = null;
  tools_baseline: string | null = null;
  known = false;
  partial = true;
  limited = false;
  last = "";
  turn = "";
  turn_index = 0;
  checklist_at = 0;
  tail_node: string | null = null;
  observe(
    turn: string,
    status: string,
    evidence: string,
    list: checklist.List,
    usage: View,
    now: number,
    calls?: Observation[],
  ) {
    if (turn !== this.turn) {
      this.turn = turn;
      this.turn_index++;
    }
    const todo = list.at !== this.checklist_at ? JSON.stringify({ items: list.items, partial: list.partial }) : "";
    const text = clip(
      `Turn ${this.turn_index}; lifecycle: ${status}\n${evidence}${todo ? "\nTODO snapshot: " + todo : ""}`,
      6000,
    );
    const key = `${turn}\n${status}\n${evidence}\n${list.at}`;
    const sample = {
      input: String(usage.tokens.input),
      cached: String(usage.tokens.cached_input),
      output: String(usage.tokens.output),
    };
    let delta = zero();
    if (usage.known) {
      this.known = true;
      if (this.baseline)
        for (const field of ["input", "cached", "output"] as const) {
          const n = BigInt(sample[field]) - BigInt(this.baseline[field]);
          if (n >= 0n) delta[field] = String(n);
          else this.partial = true;
        }
      // A delayed cache classification can exceed this interval's input; retain it as a subset.
      delta.cached = String(BigInt(delta.cached) > BigInt(delta.input) ? BigInt(delta.input) : BigInt(delta.cached));
      this.baseline = sample;
    }
    if (this.tools_baseline !== null) {
      const tools = usage.tools - BigInt(this.tools_baseline);
      if (tools >= 0n) delta.tools = String(tools);
      else this.partial = true;
    }
    this.tools_baseline = String(usage.tools);
    if (this.limited) {
      this.unassigned = add(this.unassigned, delta);
      return;
    }
    const id = (this.pending.at(-1)?.id ?? this.state.through) + 1;
    const added =
      (calls !== undefined || key !== this.last) &&
      this.tools.observe(calls, this.turn_index, id, status === "working");
    if (key === this.last && !added) {
      const previous = this.pending.at(-1);
      if (previous) this.receipts.push({ event: previous.id, tokens: delta });
      else this.attribute(this.tail_node, delta);
      this.compactReceipts();
      return;
    }
    this.last = key;
    this.checklist_at = list.at;
    if (this.pending.length === 32) {
      const dropped = this.pending.shift()!;
      this.state.through = dropped.id;
      for (const receipt of this.receipts.filter(r => r.event <= dropped.id))
        this.unassigned = add(this.unassigned, receipt.tokens);
      this.receipts = this.receipts.filter(r => r.event > dropped.id);
      this.partial = true;
    }
    this.pending.push({
      id,
      line: id,
      at: new Date(now).toISOString(),
      turn: this.turn_index,
      kind: "assistant",
      text,
    });
    this.receipts.push({ event: id, tokens: delta });
    this.compactReceipts();
  }
  compactReceipts() {
    const merged = new Map<number, Counts>();
    for (const r of this.receipts) merged.set(r.event, add(merged.get(r.event) ?? zero(), r.tokens));
    this.receipts = [...merged].map(([event, tokens]) => ({ event, tokens }));
  }
  request(): Input | null {
    if (!this.pending.length || this.limited) return null;
    const events = this.pending.slice(0, 8);
    const tools = this.tools.input(events[0].id, events.at(-1)!.id);
    return structuredClone({
      tools,
      state: this.state,
      events,
      support: this.support,
      focus: this.focus_step,
    });
  }
  apply(input: Input, raw: string) {
    if (input.state.through !== this.state.through) return false;
    const { tool_groups = [], ...patch } = JSON.parse(raw);
    plan_tools.validateGroups(input.tools ?? [], tool_groups);
    const applied = plan.apply(this.state, JSON.stringify(patch), input.events).state;
    const visits = appendVisits(this.visits, applied.spans);
    if (applied.nodes.length > 256 || visits.length > 4096) {
      this.limited = true;
      for (const call of this.tools.calls) call.running = false;
      return false;
    }
    this.visits = visits;
    this.tools.assign(input.events[0].id, applied.through, tool_groups, event => {
      const owner = applied.spans.find(s => s.from <= event && event <= s.to)?.node;
      return owner ? (visitAt(visits, owner, event)?.from ?? null) : null;
    });
    const parents = new Map(applied.nodes.map(n => [n.id, n.parent]));
    this.focus = focusEpisode(applied.nodes, applied.spans, this.focus);
    this.focus_step = focusStep(applied.spans, this.focus_step);
    this.tail_node = applied.spans.at(-1)?.node ?? null;
    for (const node of applied.nodes) this.counts[node.id] ??= zero();
    for (const r of this.receipts.filter(r => r.event <= applied.through)) {
      let id = applied.spans.find(s => r.event >= s.from && r.event <= s.to)?.node;
      if (!id) this.unassigned = add(this.unassigned, r.tokens);
      const visit = id ? visitAt(this.visits, id, r.event) : undefined;
      if (visit) visit.counts = add(visit.counts, r.tokens);
      while (id) {
        this.counts[id] = add(this.counts[id], r.tokens);
        id = parents.get(id);
      }
    }
    this.receipts = this.receipts.filter(r => r.event > applied.through);
    this.pending = this.pending.filter(e => e.id > applied.through);
    const cited = new Set(applied.nodes.flatMap(n => [...n.evidence, ...(n.bump?.evidence ?? [])]));
    this.support = [...this.support, ...input.events]
      .filter(e => cited.has(e.id))
      .slice(-128)
      .map(e => ({ ...e, text: clip(e.text, 400) }));
    this.state = { ...applied, spans: [] };
    return true;
  }
  attribute(id: string | null, tokens: Counts) {
    if (!id) this.unassigned = add(this.unassigned, tokens);
    const visit = this.visits.findLast(v => v.step === id);
    if (visit) visit.counts = add(visit.counts, tokens);
    while (id) {
      this.counts[id] = add(this.counts[id] ?? zero(), tokens);
      id = this.state.nodes.find(n => n.id === id)?.parent ?? null;
    }
  }
  /** Repeated visits to one step share its visible row until another episode intervenes. */
  toolScopes() {
    const parents = new Map(this.state.nodes.map(n => [n.id, n.parent]));
    const scopes = new Map<number, number>(),
      steps = new Map<string, number>();
    let episode: string | null | undefined;
    for (const visit of this.visits) {
      const parent = parents.get(visit.step);
      if (episode !== parent) steps.clear();
      episode = parent;
      const first = steps.get(visit.step) ?? visit.from;
      steps.set(visit.step, first);
      scopes.set(visit.from, first);
    }
    return scopes;
  }

  view(): Snapshot {
    return {
      tool_rows: this.tools.rows(this.toolScopes()),
      nodes: this.state.nodes,
      visits: this.visits,
      focus: this.focus,
      focus_step: this.focus_step,
      counts: this.counts,
      unassigned: this.receipts.reduce((n, r) => add(n, r.tokens), this.unassigned),
      known: this.known,
      partial: this.partial,
      limited: this.limited,
    };
  }
  static restore(value: unknown, live: boolean) {
    const road = new Roadmap();
    if (value === undefined) return road;
    const v = object(value),
      saved = decode(v.view);
    const integer = (key: string) => {
      const n = v[key];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw Error("InvalidRoadmap");
      return n;
    };
    road.state = { nodes: saved.nodes, spans: [], through: integer("through") };
    Object.assign(road, {
      visits: saved.visits,
      focus: saved.focus,
      focus_step: saved.focus_step,
      counts: saved.counts,
      unassigned: counts(v.unassigned),
      known: saved.known,
      partial: saved.partial,
      limited: saved.limited,
    });
    if (road.visits.some(v => v.to > road.state.through)) throw Error("InvalidRoadmap");
    const events = (value: unknown, limit: number): plan.Event[] => {
      if (!Array.isArray(value) || value.length > limit) throw Error("InvalidRoadmap");
      return value.map(e => {
        const v = object(e);
        if (
          !Number.isSafeInteger(v.id) ||
          Number(v.id) < 1 ||
          v.line !== v.id ||
          typeof v.at !== "string" ||
          v.at.length > 40 ||
          !Number.isSafeInteger(v.turn) ||
          Number(v.turn) < 0 ||
          v.kind !== "assistant" ||
          typeof v.text !== "string" ||
          Buffer.byteLength(v.text) > 6000
        )
          throw Error("InvalidRoadmap");
        return v as plan.Event;
      });
    };
    road.tools.restore(v.tool_calls, live);
    road.pending = events(v.pending, 32);
    road.support = events(v.support, 128);
    if (
      road.pending.some((e, i) => e.id !== road.state.through + i + 1) ||
      road.support.some(e => e.id > road.state.through)
    )
      throw Error("InvalidRoadmap");
    if (!Array.isArray(v.receipts) || v.receipts.length > 32) throw Error("InvalidRoadmap");
    road.receipts = v.receipts.map(r => {
      const v = object(r);
      if (!road.pending.some(e => e.id === v.event)) throw Error("InvalidRoadmap");
      return { event: Number(v.event), tokens: counts(v.tokens) };
    });
    for (const key of ["last", "turn"] as const) {
      if (typeof v[key] !== "string" || v[key].length > 12000) throw Error("InvalidRoadmap");
      road[key] = v[key];
    }
    road.turn_index = integer("turn_index");
    road.checklist_at = integer("checklist_at");
    if (
      v.tail_node !== null &&
      (typeof v.tail_node !== "string" || !road.state.nodes.some(n => n.id === v.tail_node && n.kind === "step"))
    )
      throw Error("InvalidRoadmap");
    road.tail_node = v.tail_node as string | null;
    if (live && v.baseline !== null) road.baseline = counts(v.baseline);
    if (v.tools_baseline != null) {
      if (typeof v.tools_baseline !== "string" || !/^\d{1,40}$/.test(v.tools_baseline)) throw Error("InvalidRoadmap");
      if (live) road.tools_baseline = v.tools_baseline;
    }
    if (!live) {
      road.last = "";
      road.tail_node = null;
    }
    return road;
  }
  toJSON() {
    return {
      view: { ...this.view(), tool_rows: undefined },
      tool_calls: this.tools.calls,
      through: this.state.through,
      unassigned: this.unassigned,
      baseline: this.baseline,
      tools_baseline: this.tools_baseline,
      pending: this.pending,
      support: this.support,
      receipts: this.receipts,
      last: this.last,
      turn: this.turn,
      turn_index: this.turn_index,
      checklist_at: this.checklist_at,
      tail_node: this.tail_node,
    };
  }
}
