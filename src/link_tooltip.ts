import type { Target as AgentTarget } from "./sidebar";
export interface Target {
  resource?: number | null;
  git?: number | null;
  worktree?: number | null;
  usage?: boolean;
  conversation?: number;
  agent?: AgentTarget | null;
}
function same(a: Target, b: Target) {
  return (
    (a.resource ?? null) === (b.resource ?? null) &&
    (a.git ?? null) === (b.git ?? null) &&
    (a.worktree ?? null) === (b.worktree ?? null) &&
    (a.usage ?? false) === (b.usage ?? false) &&
    (a.conversation ?? 0) === (b.conversation ?? 0) &&
    JSON.stringify(a.agent ?? null) === JSON.stringify(b.agent ?? null)
  );
}
export class State {
  suppressed = true;
  target: Target | null = null;
  since = 0;
  shown = false;
  cancel() {
    this.suppressed = true;
    this.target = null;
    this.shown = false;
  }
  move() {
    this.suppressed = false;
    this.target = null;
    this.shown = false;
  }
  due(now: number) {
    return !this.suppressed && this.target !== null && !this.shown && now - this.since >= 500;
  }
  ready(target: Target | null, now: number) {
    if (this.suppressed || !target) {
      this.target = null;
      this.shown = false;
      return false;
    }
    if (!this.target || !same(this.target, target)) {
      this.target = target;
      this.since = now;
      this.shown = false;
      return false;
    }
    this.shown = now - this.since >= 500;
    return this.shown;
  }
}
