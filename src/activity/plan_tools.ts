import { shortLabel, type Observation, type Outcome } from "./tools";

export type Input = { id: number; event: number; detail: string; description: string };
export type Group = { ids: number[]; title: string };
export type Row = {
  visit: number | null;
  title: string;
  running: boolean;
  outcome?: Outcome | "unknown";
  members?: string[];
  first?: number;
};
type Call = Input & {
  visit: number | null;
  title: string;
  running: boolean;
  key: string;
  turn: number;
  group: number;
  group_title?: string;
  outcome?: Outcome | null;
  recap?: { stamp: string; title: string };
};
type Bucket = { visit: number | null; calls: Call[] };
export type Recap = { id: number; stamp: string; outcome: NonNullable<Row["outcome"]>; labels: string[] };
const capacity = 512;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const label = (v: unknown): v is string => typeof v === "string" && !!v && shortLabel(v) === v;
const outcomes = new Set(["success", "failure", "unknown"]);
const shell = /^(?:(?:functions|tools)\.)?(?:exec(?:_command)?|bash|shell|sh|terminal)$/i;

/** Use concrete arguments immediately. A bare shell wrapper contributes only its glyph. */
function fallback(detail: string) {
  const colon = detail.indexOf(":");
  const name = (colon < 0 ? detail : detail.slice(0, colon)).trim();
  const args = colon < 0 ? "" : detail.slice(colon + 1).trim();
  if (shell.test(name)) return !args || args.split(/;\s*/).every(arg => shell.test(arg)) ? "…" : shortLabel(args);
  return shortLabel(detail) || "…";
}
function description(value: string) {
  return shell.test(value) ? "" : value;
}
function member(call: Call) {
  return description(call.description) || (call.title !== "…" ? call.title : "") || fallback(call.detail);
}

export function validateGroups(calls: Input[], groups: Group[]) {
  const byId = new Map(calls.map(c => [c.id, c]));
  const used = new Set<number>();
  for (const group of groups) {
    if (!Array.isArray(group.ids) || !group.ids.length || !label(group.title)) throw Error("InvalidToolGroup");
    const event = byId.get(group.ids[0])?.event;
    for (const id of group.ids) {
      if (!byId.has(id) || byId.get(id)!.event !== event || used.has(id)) throw Error("InvalidToolGroup");
      used.add(id);
    }
  }
}

export class Ledger {
  calls: Call[] = [];

  /** A snapshot can repeat, or finish several calls before the next inference. */
  observe(observed: Observation[] | undefined, turn: number, event: number, working: boolean) {
    const current = new Map(observed?.map(c => [c.key, c]));
    const existing = new Set<string>();
    for (const call of this.calls) {
      if (call.turn !== turn) {
        call.running = false;
        continue;
      }
      existing.add(call.key);
      if (!working || observed) {
        const update = current.get(call.key);
        call.running = working && !!update?.running;
        if (update?.outcome) call.outcome = update.outcome;
        if (update?.description && description(update.description) && update.description !== call.description) {
          call.description = update.description;
          if (!this.calls.some(other => other !== call && other.group === call.group)) call.title = update.description;
        }
      }
    }
    let added = false;
    for (const call of observed ?? []) {
      if (existing.has(call.key)) continue;
      existing.add(call.key);
      const id = (this.calls.at(-1)?.id ?? 0) + 1;
      this.calls.push({
        id,
        event,
        turn,
        key: call.key,
        detail: call.detail,
        description: description(call.description),
        title: description(call.description) || fallback(call.detail),
        group: id,
        visit: null,
        running: working && call.running,
        outcome: call.outcome ?? null,
      });
      added = true;
    }
    while (this.calls.length > capacity) {
      const index = this.calls.findIndex(c => !c.running && !(c.turn === turn && current.has(c.key)));
      this.calls.splice(Math.max(0, index), 1);
    }
    return added;
  }

  input(from: number, to: number): Input[] {
    return this.calls
      .filter(c => c.event >= from && c.event <= to && (c.description || fallback(c.detail) !== "…"))
      .map(({ id, event, detail, description }) => ({ id, event, detail, description }));
  }

  assign(from: number, to: number, groups: Group[], visit: (event: number) => number | null) {
    const labels = new Map(groups.flatMap(g => g.ids.map(id => [id, g] as const)));
    for (const c of this.calls) {
      if (c.event < from || c.event > to) continue;
      c.visit = visit(c.event);
      const group = labels.get(c.id);
      if (!group) continue;
      c.group = group.ids[0];
      if (group.ids.length === 1) c.title = c.description || description(group.title) || fallback(c.detail);
      else c.group_title = description(group.title) || undefined;
    }
  }

  private buckets(scopes: Map<number, number>) {
    const buckets = new Map<string, Bucket>();
    for (const c of this.calls) {
      const visit = c.visit === null ? null : (scopes.get(c.visit) ?? c.visit);
      const key = c.running ? "live:" + c.group : (visit ?? "turn" + c.turn) + ":" + (c.outcome ?? "unknown");
      const bucket = buckets.get(key);
      if (bucket) bucket.calls.push(c);
      else buckets.set(key, { visit, calls: [c] });
    }
    return [...buckets.values()];
  }

  rows(scopes: Map<number, number>): Row[] {
    return this.buckets(scopes)
      .sort((a, b) => Number(b.calls[0].running) - Number(a.calls[0].running))
      .map(({ visit, calls }) => {
        const first = calls[0];
        if (first.running)
          return {
            visit,
            title: calls.length === 1 ? member(first) : (first.group_title ?? first.title),
            running: true,
          };
        const members = calls.map(member);
        const stamp = signature(calls, members);
        const names = [...new Set(members.filter(t => t !== "…"))];
        const title =
          first.recap?.stamp === stamp ? first.recap.title : shortLabel(names.slice(0, 2).join(" · ")) || "…";
        return { visit, title, running: false, outcome: first.outcome ?? "unknown", members, first: first.id };
      });
  }

  recaps(scopes: Map<number, number>): Recap[] {
    const requests: Recap[] = [];
    for (const { visit, calls } of this.buckets(scopes)) {
      const first = calls[0];
      if (visit === null || first.running || calls.length < 2) continue;
      const names = calls.map(member),
        stamp = signature(calls, names);
      const labels = [...new Set(names.filter(t => t !== "…"))];
      if (labels.length && first.recap?.stamp !== stamp)
        requests.push({
          id: first.id,
          stamp,
          outcome: first.outcome ?? "unknown",
          labels: labels.length > 12 ? [...labels.slice(0, 6), ...labels.slice(-6)] : labels,
        });
    }
    return requests;
  }

  remember(request: Recap, title: string) {
    const first = this.calls.find(call => call.id === request.id);
    if (first && label(title)) first.recap = { stamp: request.stamp, title };
  }

  restore(value: unknown, live: boolean) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > capacity) throw Error("InvalidRoadmap");
    let last = 0;
    this.calls = value.map(c => {
      if (
        !integer(c?.id) ||
        c.id <= last ||
        !integer(c.event) ||
        !integer(c.turn) ||
        !integer(c.group) ||
        typeof c.key !== "string" ||
        c.key.length > 32 ||
        typeof c.detail !== "string" ||
        Buffer.byteLength(c.detail) > 240 ||
        typeof c.description !== "string" ||
        shortLabel(c.description) !== c.description ||
        !validRow(c) ||
        (c.group_title !== undefined && !label(c.group_title)) ||
        (c.outcome != null && c.outcome !== "success" && c.outcome !== "failure") ||
        (c.recap != null &&
          (!label(c.recap.title) || typeof c.recap.stamp !== "string" || !/^[0-9a-f]{1,16}$/.test(c.recap.stamp)))
      )
        throw Error("InvalidRoadmap");
      last = c.id;
      return { ...c, title: shell.test(c.title) ? fallback(c.detail) : c.title, running: live && c.running };
    });
  }
}
function signature(calls: Call[], names: string[]) {
  return Bun.hash(JSON.stringify([calls[0].outcome, calls.map(c => c.id), names])).toString(16);
}
function validRow(row: Row) {
  return (
    row &&
    (row.visit === null || row.visit === 0 || integer(row.visit)) &&
    label(row.title) &&
    typeof row.running === "boolean"
  );
}
export function decodeRows(value: unknown): Row[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > capacity) throw Error("InvalidRoadmap");
  let total = 0;
  return value.map(row => {
    if (!validRow(row)) throw Error("InvalidRoadmap");
    const { visit, title, running, outcome, members, first } = row;
    if (outcome === undefined) return { visit, title, running };
    if (
      running ||
      !outcomes.has(outcome) ||
      !integer(first) ||
      !Array.isArray(members) ||
      !members.length ||
      (total += members.length) > capacity ||
      !members.every(label)
    )
      throw Error("InvalidRoadmap");
    return { visit, title, running, outcome, members, first };
  });
}
