import { shortLabel, type Observation } from "./tools";

export type Input = { id: number; event: number; detail: string; description: string };
export type Group = { ids: number[]; title: string };
export type Row = { visit: number | null; title: string; running: boolean };
type Call = Input & Row & { key: string; turn: number; group: number };
const capacity = 512;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function validateGroups(calls: Input[], groups: Group[]) {
  const byId = new Map(calls.map(c => [c.id, c]));
  const used = new Set<number>();
  for (const group of groups) {
    if (
      !Array.isArray(group.ids) ||
      !group.ids.length ||
      typeof group.title !== "string" ||
      !group.title ||
      shortLabel(group.title) !== group.title
    )
      throw Error("InvalidToolGroup");
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
        if (update?.description && update.description !== call.description) {
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
        description: call.description,
        title: call.description || shortLabel(call.detail.split(":", 1)[0]) || "…",
        group: id,
        visit: null,
        running: working && call.running,
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
      .filter(c => c.event >= from && c.event <= to)
      .map(({ id, event, detail, description }) => ({ id, event, detail, description }));
  }

  assign(from: number, to: number, groups: Group[], visit: (event: number) => number | null) {
    const labels = new Map(groups.flatMap(g => g.ids.map(id => [id, g] as const)));
    for (const c of this.calls) {
      if (c.event > to || (c.event < from && c.visit !== null)) continue;
      c.detail = "";
      c.visit = visit(c.event);
      const group = labels.get(c.id);
      if (!group) continue;
      c.group = group.ids[0];
      c.title = group.ids.length === 1 && c.description ? c.description : group.title;
    }
  }

  rows(): Row[] {
    const rows = new Map<number, Row>();
    for (const call of this.calls) {
      const row = rows.get(call.group);
      if (row) row.running ||= call.running;
      else rows.set(call.group, { visit: call.visit, title: call.title, running: call.running });
    }
    return [...rows.values()];
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
        !validRow(c)
      )
        throw Error("InvalidRoadmap");
      last = c.id;
      return { ...c, running: live && c.running };
    });
  }
}
function validRow(row: Row) {
  return (
    row &&
    (row.visit === null || row.visit === 0 || integer(row.visit)) &&
    typeof row.title === "string" &&
    !!row.title &&
    shortLabel(row.title) === row.title &&
    typeof row.running === "boolean"
  );
}
export function decodeRows(value: unknown): Row[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > capacity || !value.every(validRow)) throw Error("InvalidRoadmap");
  return value.map(({ visit, title, running }) => ({ visit, title, running }));
}
