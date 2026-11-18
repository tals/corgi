//! Explicit saved-state revisions and their shared migration runner.
export type Step = (value: unknown) => unknown;
export type Revision = { id: string; parent: string | null; description: string; up: Step; down: Step | null };
export type Kind = "state" | "checkpoint" | "handoff" | "workspaces" | "viewer";
export const baseline = "68139a93dee0";
/** Numbered snapshots enter the shared state history here. */
export const initial = "e2a57d17f66f";
export function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{12}$/.test(value);
}
export function parse(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1024) throw Error("InvalidStateFormats");
  if (!value.every(id) || new Set(value).size !== value.length || !value.includes(baseline))
    throw Error("InvalidStateFormats");
  return value;
}
/** Only the state lineage at or above the terminal baseline participates in live handoff. */
export function supported(history: History): string[] {
  const floor = history.ancestors.indexOf(baseline);
  if (floor < 0) throw Error("InvalidHandoffHistory");
  return parse(history.ancestors.slice(0, floor + 1));
}
export function select(history: History, readable: readonly string[]): string {
  const accepted = new Set(parse(readable));
  return supported(history).find(id => accepted.has(id))!;
}
export class History {
  readonly ancestors: string[];
  private readonly path: Revision[] = [];
  constructor(
    readonly current: string,
    revisions: readonly Revision[],
  ) {
    const byId = new Map(revisions.map(revision => [revision.id, revision])),
      children = new Set<string>();
    if (byId.size !== revisions.length) throw Error("InvalidStateHistory");
    for (const revision of revisions) {
      if (
        !id(revision.id) ||
        !revision.description.trim() ||
        (revision.parent !== null && !byId.has(revision.parent)) ||
        typeof revision.up !== "function" ||
        (revision.down !== null && typeof revision.down !== "function")
      )
        throw Error("InvalidStateHistory");
      if (revision.parent !== null) {
        if (children.has(revision.parent)) throw Error("ForkedStateHistory");
        children.add(revision.parent);
      }
    }
    for (const revision of revisions) {
      const seen = new Set<string>();
      for (let id: string | null = revision.id; id !== null; id = byId.get(id)!.parent) {
        if (seen.has(id)) throw Error("InvalidStateHistory");
        seen.add(id);
      }
    }
    for (let id: string | null = current; id !== null;) {
      const step = byId.get(id);
      if (!step) throw Error("InvalidStateHistory");
      this.path.push(step);
      id = step.parent;
    }
    this.ancestors = this.path.map(step => step.id);
  }
  down(value: unknown, target: string): unknown {
    const index = this.ancestors.indexOf(target);
    if (index < 0) throw Error("UnsupportedStateFormat");
    let result = structuredClone(value);
    for (let i = 0; i < index; i++) {
      const step = this.path[i];
      if (step.down === null) throw Error("UnsupportedStateDowngrade");
      result = step.down(result);
    }
    return result;
  }
  up(value: unknown, source: string): unknown {
    const index = this.ancestors.indexOf(source);
    if (index < 0) throw Error("UnsupportedStateFormat");
    let result = structuredClone(value);
    for (let i = index - 1; i >= 0; i--) result = this.path[i].up(result);
    return result;
  }
}

/** A checkout contains one complete chain for each saved format. */
export function histories(heads: Record<Kind, string>, revisions: readonly Revision[]): Record<Kind, History> {
  const result = {
    state: new History(heads.state, revisions),
    checkpoint: new History(heads.checkpoint, revisions),
    handoff: new History(heads.handoff, revisions),
    workspaces: new History(heads.workspaces, revisions),
    viewer: new History(heads.viewer, revisions),
  };
  const selected = Object.values(result).flatMap(history => history.ancestors);
  if (selected.length !== revisions.length || new Set(selected).size !== selected.length)
    throw Error("InvalidStateHeads");
  supported(result.state);
  return result;
}
