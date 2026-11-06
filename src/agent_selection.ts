import * as sidebar from "./sidebar";
import type { Entry, Target } from "./sidebar";
import { key, type Target as OrderTarget } from "./agent_order";

const selectable = (e: Entry) => sidebar.isAgent(e.target) && e.exit === null && !e.worktree?.ghost;
const contains = (targets: readonly Target[], target: Target) => targets.some(t => sidebar.sameTarget(t, target));

/** Viewer-local marks and a range layered over the marks present when it began. */
export class Selection {
  targets: OrderTarget[] = [];
  anchor: Target | null = null;
  visual = false;
  private range: { anchor: Target; base: OrderTarget[]; order: OrderTarget[] } | null = null;
  private held: Entry[] | null = null;

  has(target: Target): boolean {
    return contains(this.targets, target);
  }
  active(): boolean {
    return this.targets.length > 0 || this.visual;
  }
  point(target: Target | null): void {
    this.anchor = target;
    this.range = null;
    this.visual = false;
  }
  toggle(target: Target): void {
    if (!sidebar.isAgent(target)) return;
    this.point(target);
    this.targets = this.has(target)
      ? this.targets.filter(t => !sidebar.sameTarget(t, target))
      : [...this.targets, target];
    if (!this.active()) this.held = null;
  }
  extend(entries: Entry[], target: Target): void {
    const order = entries.filter(selectable).map(e => e.target as OrderTarget);
    if (!contains(order, target)) return;
    if (!this.range) {
      const anchor = this.anchor && contains(order, this.anchor) ? this.anchor : target;
      this.anchor = anchor;
      this.range = { anchor, base: [...this.targets], order };
    }
    const a = this.range.order.findIndex(t => sidebar.sameTarget(t, this.range!.anchor));
    const b = this.range.order.findIndex(t => sidebar.sameTarget(t, target));
    if (a < 0 || b < 0) return;
    this.targets = [...this.range.base];
    for (const t of this.range.order.slice(Math.min(a, b), Math.max(a, b) + 1)) if (!this.has(t)) this.targets.push(t);
  }
  move(entries: Entry[], cursor: Target, down: boolean): Target | null {
    const order = entries.filter(selectable).map(e => e.target);
    if (!order.length) return null;
    let index = order.findIndex(t => sidebar.sameTarget(t, cursor));
    if (index < 0) {
      const start = entries.findIndex(e => sidebar.sameTarget(e.target, cursor));
      const next = down
        ? entries.slice(start + 1).find(selectable)
        : entries.slice(0, Math.max(0, start)).reverse().find(selectable);
      if (!next) return null;
      this.anchor = next.target;
      index = order.findIndex(t => sidebar.sameTarget(t, next.target));
    } else index = Math.max(0, Math.min(order.length - 1, index + (down ? 1 : -1)));
    if (!this.anchor) this.anchor = cursor;
    this.extend(entries, order[index]);
    return order[index];
  }
  start(entries: Entry[], cursor: Target): void {
    if (this.visual) return this.commit(cursor);
    if (!entries.some(e => selectable(e) && sidebar.sameTarget(e.target, cursor))) return;
    this.point(cursor);
    this.visual = true;
    this.extend(entries, cursor);
  }
  commit(cursor: Target | null = this.anchor): void {
    this.point(cursor);
  }
  resetOrder(): void {
    this.commit();
    this.held = null;
  }
  all(entries: Entry[]): void {
    this.commit();
    for (const e of entries) if (selectable(e) && !this.has(e.target)) this.targets.push(e.target as OrderTarget);
  }
  clear(): void {
    this.targets = [];
    this.anchor = null;
    this.range = null;
    this.visual = false;
    this.held = null;
  }
  escape(): boolean {
    if (this.visual && this.range) {
      this.targets = this.range.base;
      this.commit();
      if (!this.active()) this.held = null;
      return true;
    }
    if (!this.targets.length) return false;
    this.clear();
    return true;
  }
  keep(valid: (target: OrderTarget) => boolean): number {
    const before = this.targets.length;
    this.targets = this.targets.filter(valid);
    if (this.range) {
      this.range.base = this.range.base.filter(valid);
      this.range.order = this.range.order.filter(valid);
      if (!contains(this.range.order, this.range.anchor)) this.commit();
    }
    if (this.anchor && sidebar.isAgent(this.anchor) && !valid(this.anchor)) this.anchor = null;
    if (!this.active()) this.held = null;
    return before - this.targets.length;
  }
  /** Keep row positions and grouping while statuses update; new rows wait until marks clear. */
  ordered(entries: Entry[]): Entry[] {
    if (!this.active()) {
      this.held = null;
      return entries;
    }
    this.held ??= entries.map(e => ({ ...e }));
    const agents = new Map(entries.filter(e => sidebar.isAgent(e.target)).map(e => [key(e.target as OrderTarget), e]));
    const result: Entry[] = [];
    for (const previous of this.held) {
      if (sidebar.isAgent(previous.target)) {
        const current = agents.get(key(previous.target));
        if (current) result.push({ ...current, section: previous.section, worktree: previous.worktree });
      } else result.push(previous);
    }
    for (let i = result.length - 1; i >= 0; i--) {
      if (!sidebar.isHeading(result[i].target)) continue;
      const members = result.slice(i + 1, sidebar.groupEnd(result, i)).filter(selectable);
      if (!members.length) {
        result.splice(i, 1);
        continue;
      }
      const group = { ...result[i].group, agents: 0, working: 0, attention: 0 };
      for (const e of members) sidebar.tally(group, e.state, e.attention);
      result[i] = { ...result[i], group };
    }
    return result;
  }
}
