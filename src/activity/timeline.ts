import { Text } from "../providers/common";
import { Tokens, View } from "../usage/live";
import { add, max, sub } from "../usage/tokens";
import type * as todos from "./todos";

export type TaskSource = "agent" | "inferred";
export type Task = {
  id: string;
  label: string;
  phase: string;
  status: todos.Status | null;
  source: TaskSource;
  present: boolean;
  blocker?: string;
};
export type TaskSelection = { id: string | null; label: string | null };
export type TaskContext = { revision: number; supplied: boolean; current_task: string | null; tasks: Task[] };
export type TaskView = Task & { usage: View };
export type Point = { at: number; label: Text; usage: View; readonly task_id: string | null };

const statuses: Record<string, true> = {
  pending: true,
  in_progress: true,
  completed: true,
  abandoned: true,
  blocked: true,
};
const taskLimit = 128;
const planLimit = 64;
const labelLimit = 512;
const validLabel = (label: unknown): label is string =>
  typeof label === "string" &&
  label.length > 0 &&
  label.length <= labelLimit &&
  label.trim() === label &&
  !/[\x00-\x1f\x7f]/.test(label);
const copyUsage = (value: View) => new View({ ...value, tokens: new Tokens(value.tokens) });
function accumulate(target: View, value: View) {
  target.tokens.add(value.tokens);
  target.turns = add(target.turns, value.turns);
  target.tools = add(target.tools, value.tools);
  target.counts_known &&= value.counts_known;
  target.known ||= value.known;
  target.partial ||= value.partial;
  target.losses = Math.min(0xffffffff, target.losses + value.losses);
  target.since = target.since && value.since ? Math.min(target.since, value.since) : target.since || value.since;
  target.updated_at = Math.max(target.updated_at, value.updated_at);
}

/** Keep 16 activity details and 128 goal headers (at most 64 supplied placeholders).
 * Evicted details roll into their goal exactly; evicted goal headers are counted, never
 * reassigned to another goal. Actor totals remain authoritative beyond this window. */
export class Timeline {
  points: Point[] = [];
  tasks: Task[] = [];
  retired: Record<string, View> = {};
  omitted_tasks = 0;
  plan_omitted = 0;
  plan_signature = "";
  current_task: string | null = null;
  revision = 0;
  supplied = false;
  next_id = 1;
  get len() {
    return this.points.length;
  }
  baseline = new View({ known: true, counts_known: true });
  turn = new Text();
  open = true;
  private revise() {
    if (this.revision === 0xffffffff) throw Error("TaskRevisionExhausted");
    this.revision++;
  }
  private id() {
    if (this.next_id >= 0xffffffff) throw Error("TaskIdentityExhausted");
    return `task-${this.next_id++}`;
  }
  private prune() {
    while (this.tasks.length > taskLimit) {
      const index = this.tasks.findIndex(
        task => !task.present && task.id !== this.current_task && !this.points.some(point => point.task_id === task.id),
      );
      if (index < 0) throw Error("TaskCapacityExceeded");
      const [task] = this.tasks.splice(index, 1);
      delete this.retired[task.id];
      this.omitted_tasks = Math.min(0xffffffff, this.omitted_tasks + 1);
    }
  }
  taskContext(): TaskContext {
    return {
      revision: this.revision,
      supplied: this.supplied,
      current_task: this.current_task,
      tasks: this.tasks.map(task => ({ ...task })),
    };
  }
  syncPlan(phases: readonly todos.Phase[], current: View, now: number) {
    const signature = Bun.hash.wyhash(JSON.stringify(phases), 0n).toString(16);
    const observed = phases.flatMap(phase =>
      phase.tasks.map(task => ({
        label: task.content.trim(),
        phase: phase.name,
        status: task.status,
        ...(task.blocker === undefined ? {} : { blocker: task.blocker.slice(0, labelLimit) }),
      })),
    );
    const plan = observed.filter(task => validLabel(task.label) && task.phase.length <= labelLimit).slice(0, planLimit);
    const omitted = observed.length - plan.length;
    const supplied = observed.length > 0;
    const previous = this.tasks.filter(task => task.source === "agent" && task.present);
    if (
      signature === this.plan_signature &&
      supplied === this.supplied &&
      omitted === this.plan_omitted &&
      previous.length === plan.length &&
      previous.every((task, index) => {
        const next = plan[index];
        return (
          task.label === next.label &&
          task.phase === next.phase &&
          task.status === next.status &&
          task.blocker === next.blocker
        );
      })
    )
      return;

    const used = new Set<string>();
    const next: Task[] = plan.map(item => {
      const matches = this.tasks.filter(
        task => task.source === "agent" && task.label === item.label && task.phase === item.phase,
      );
      const unique = plan.filter(task => task.label === item.label && task.phase === item.phase).length === 1;
      let existing = unique && matches.length === 1 ? matches[0] : undefined;
      if (!existing && !matches.length && plan.filter(task => task.label === item.label).length === 1) {
        const moved = this.tasks.filter(task => task.source === "agent" && task.label === item.label);
        if (moved.length === 1) existing = moved[0];
      }
      if (!existing && !matches.length && plan.filter(task => task.label === item.label).length === 1) {
        const inferred = this.tasks.filter(task => task.source === "inferred" && task.label === item.label);
        if (inferred.length === 1) existing = inferred[0];
      }
      const task: Task = { id: existing?.id ?? this.id(), ...item, source: "agent", present: true };
      used.add(task.id);
      return task;
    });
    // Close a removed owner's interval at observation, not at the next summary.
    // Starting an unassigned interval also preserves pre-plan usage when no label exists.
    const intervalOwner = this.open ? this.points.at(-1)?.task_id : null;
    const currentRemoved =
      (supplied || this.supplied) &&
      ((this.current_task !== null && !used.has(this.current_task)) ||
        (intervalOwner != null && !used.has(intervalOwner)));
    const priorUsage =
      current.tokens.input > 0n || current.tokens.output > 0n || current.turns > 0n || current.tools > 0n;
    if (currentRemoved || (!this.supplied && supplied && !this.len && priorUsage)) {
      const label = this.points.at(-1)?.label ?? new Text("Unassigned activity");
      this.checkpoint(this.turn.text(), label, current, now, null);
      this.current_task = null;
    }
    const old = this.tasks
      .filter(task => !used.has(task.id))
      .map(task => (task.source === "agent" ? { ...task, present: false } : task));
    this.tasks = [
      ...old.filter(
        task =>
          task.source === "inferred" || this.retired[task.id] || this.points.some(point => point.task_id === task.id),
      ),
      ...next,
    ];
    this.supplied = supplied;
    this.omitted_tasks = Math.min(0xffffffff, this.omitted_tasks - this.plan_omitted + omitted);
    this.plan_omitted = omitted;
    this.plan_signature = signature;
    this.prune();
    this.revise();
  }
  selectTask(selection: TaskSelection, completed: readonly string[]): string | null {
    const task = selection.id === null ? undefined : this.tasks.find(task => task.id === selection.id);
    if (
      (selection.id !== null && !task) ||
      (selection.label !== null && !validLabel(selection.label)) ||
      (task?.source === "agent" && (!task.present || (selection.label !== null && selection.label !== task.label))) ||
      (this.supplied && (task?.source === "inferred" || (!task && selection.label !== null))) ||
      completed.some(id => !this.tasks.some(task => task.id === id && task.source === "inferred"))
    )
      throw Error("InvalidTaskSelection");
    let selected = task;
    let changed = false;
    if (!selected && selection.label !== null) {
      const matching = this.tasks.filter(task => task.source === "inferred" && task.label === selection.label);
      if (matching.length === 1) selected = matching[0];
      else {
        selected = {
          id: this.id(),
          label: selection.label,
          phase: "",
          status: null,
          source: "inferred",
          present: false,
        };
        this.tasks.push(selected);
        changed = true;
      }
    }
    if (selected?.source === "inferred" && selection.label !== null && selected.label !== selection.label) {
      selected.label = selection.label;
      changed = true;
    }
    for (const id of completed) {
      const done = this.tasks.find(task => task.id === id)!;
      if (done.status !== "completed") {
        done.status = "completed";
        changed = true;
      }
    }
    const id = selected?.id ?? null;
    changed ||= this.current_task !== id;
    this.current_task = id;
    this.prune();
    if (changed) this.revise();
    return id;
  }
  taskViews(current: View): TaskView[] {
    const live = this.pending(current);
    return this.tasks.map(task => {
      let usage = this.retired[task.id] ? copyUsage(this.retired[task.id]) : null;
      for (let i = 0; i < this.points.length; i++) {
        const point = this.points[i];
        if (point.task_id !== task.id) continue;
        const value = i === this.points.length - 1 ? live : point.usage;
        if (usage) accumulate(usage, value);
        else usage = copyUsage(value);
      }
      return { ...task, usage: usage ?? new View() };
    });
  }
  observedDelta(current: View) {
    const delta = new View({
      known: current.known,
      partial: current.losses !== this.baseline.losses,
      losses: Math.max(0, current.losses - this.baseline.losses),
      since: this.points.at(-1)?.at ?? current.since,
      updated_at: current.updated_at,
    });
    delta.counts_known = current.counts_known && this.baseline.counts_known;
    if (delta.counts_known) {
      for (const k of ["turns", "tools"] as const) {
        delta[k] = sub(current[k], this.baseline[k]);
        if (current[k] < this.baseline[k]) delta.counts_known = false;
      }
    }
    if (delta.partial) delta.counts_known = false;
    if (!current.known) return delta;
    for (const k of ["input", "cached_input", "output"] as const) {
      delta.tokens[k] = sub(current.tokens[k], this.baseline.tokens[k]);
      if (current.tokens[k] < this.baseline.tokens[k]) delta.partial = true;
    }
    return delta;
  }
  pending(current: View) {
    if (!this.open && this.len) return this.points.at(-1)!.usage;
    const value = this.observedDelta(current),
      last = this.points.at(-1)?.usage;
    if (last) {
      value.tokens.add(last.tokens);
      value.turns = add(value.turns, last.turns);
      value.tools = add(value.tools, last.tools);
      value.counts_known &&= last.counts_known;
      value.known ||= last.known;
      value.partial ||= last.partial;
      value.losses = Math.min(0xffffffff, value.losses + last.losses);
    }
    return value;
  }
  checkpoint(turn: string, label: Text, current: View, now: number, task_id: string | null = this.current_task) {
    const owner = task_id === null ? undefined : this.tasks.find(task => task.id === task_id);
    if (task_id !== null && (!owner || (owner.source === "agent" ? !owner.present : this.supplied)))
      throw Error("InvalidTaskSelection");
    if (owner?.source === "inferred" && owner.status !== "completed" && owner.status !== "in_progress") {
      owner.status = "in_progress";
      this.revise();
    }
    const interval = this.pending(current),
      last = this.points.at(-1),
      at = last ? Math.max(now, last.at) : now;
    if (last) last.usage = interval;
    if (!(
      this.open &&
      last &&
      turn === this.turn.text() &&
      label.text() === last.label.text() &&
      last.task_id === task_id
    )) {
      if (this.len === 16) {
        const evicted = this.points.shift()!;
        if (evicted.task_id !== null) {
          const previous = this.retired[evicted.task_id];
          if (previous) accumulate(previous, evicted.usage);
          else this.retired[evicted.task_id] = copyUsage(evicted.usage);
        }
      }
      this.points.push({
        at,
        label,
        task_id,
        usage: !this.len
          ? interval
          : !this.open
            ? this.observedDelta(current)
            : new View({ known: current.known, counts_known: current.counts_known }),
      });
    }
    this.turn = new Text(turn);
    this.open = true;
    this.advanceBaseline(current);
  }
  /** Renames the turn's open phase, or starts one when the turn has none. */
  amend(turn: string, label: Text, current: View, now: number, task_id: string | null = this.current_task) {
    const last = this.points.at(-1);
    if (this.open && last && turn === this.turn.text() && last.task_id === task_id) last.label = label;
    this.checkpoint(turn, label, current, now, task_id);
  }
  finish(current: View) {
    if (this.len) this.points.at(-1)!.usage = this.pending(current);
    this.open = false;
    this.advanceBaseline(current);
  }
  advanceBaseline(current: View) {
    for (const k of ["input", "cached_input", "output"] as const)
      this.baseline.tokens[k] =
        this.baseline.tokens[k] > current.tokens[k] ? this.baseline.tokens[k] : current.tokens[k];
    for (const k of ["turns", "tools"] as const)
      this.baseline[k] = this.baseline[k] > current[k] ? this.baseline[k] : current[k];
    this.baseline.counts_known = current.counts_known;
    this.baseline.known = current.known;
    this.baseline.losses = current.losses;
  }
  /** Live-handoff input is untrusted; reject corruption instead of dropping ownership. */
  static restore(value: unknown): Timeline {
    const timeline = new Timeline();
    if (value === undefined || value === null) return timeline;
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("InvalidCheckpoint");
      return value as Record<string, unknown>;
    };
    const integer = (value: unknown, limit = 0xffffffff): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > limit)
        throw Error("InvalidCheckpoint");
      return value;
    };
    const boolean = (value: unknown): boolean => {
      if (typeof value !== "boolean") throw Error("InvalidCheckpoint");
      return value;
    };
    const count = (value: unknown): bigint => {
      if (
        typeof value !== "bigint" &&
        !(typeof value === "string" && /^\d{1,20}$/.test(value)) &&
        !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      )
        throw Error("InvalidCheckpoint");
      const result = BigInt(value as string | number | bigint);
      if (result < 0n || result > max) throw Error("InvalidCheckpoint");
      return result;
    };
    const usage = (value: unknown): View => {
      const saved = object(value),
        tokens = object(saved.tokens);
      return new View({
        tokens: new Tokens({
          input: count(tokens.input),
          cached_input: count(tokens.cached_input),
          output: count(tokens.output),
        }),
        known: boolean(saved.known),
        partial: boolean(saved.partial),
        losses: integer(saved.losses),
        since: integer(saved.since, Number.MAX_SAFE_INTEGER),
        updated_at: integer(saved.updated_at, Number.MAX_SAFE_INTEGER),
        turns: count(saved.turns === undefined ? 0n : saved.turns),
        tools: count(saved.tools === undefined ? 0n : saved.tools),
        counts_known: boolean(saved.counts_known === undefined ? false : saved.counts_known),
        recent_tokens: count(saved.recent_tokens === undefined ? 0n : saved.recent_tokens),
      });
    };
    const text = (value: unknown, limit: number): Text => {
      if (value instanceof Text) value = value.toJSON();
      if ((typeof value !== "string" && !Array.isArray(value)) || value.length > limit)
        throw Error("InvalidCheckpoint");
      return Text.fromJSON(value);
    };
    const saved = object(value);
    const tasks = saved.tasks === undefined ? [] : saved.tasks;
    if (!Array.isArray(tasks) || tasks.length > taskLimit) throw Error("InvalidCheckpoint");
    const ids = new Set<string>();
    let greatest = 0;
    timeline.tasks = tasks.map((value: unknown): Task => {
      const task = object(value);
      if (
        typeof task.id !== "string" ||
        !/^task-[1-9]\d{0,9}$/.test(task.id) ||
        ids.has(task.id) ||
        !validLabel(task.label) ||
        typeof task.phase !== "string" ||
        task.phase.length > labelLimit ||
        (task.status !== null && (typeof task.status !== "string" || !Object.hasOwn(statuses, task.status))) ||
        (task.source !== "agent" && task.source !== "inferred") ||
        (task.blocker !== undefined && (typeof task.blocker !== "string" || task.blocker.length > labelLimit))
      )
        throw Error("InvalidCheckpoint");
      const ordinal = integer(Number(task.id.slice(5)));
      greatest = Math.max(greatest, ordinal);
      ids.add(task.id);
      const present = boolean(task.present);
      if (task.source === "inferred" && present) throw Error("InvalidCheckpoint");
      return {
        id: task.id,
        label: task.label,
        phase: task.phase,
        status: task.status as todos.Status | null,
        source: task.source,
        present,
        ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
      };
    });
    const current = saved.current_task ?? null;
    if (current !== null && (typeof current !== "string" || !ids.has(current))) throw Error("InvalidCheckpoint");
    timeline.current_task = current;
    timeline.revision = integer(saved.revision === undefined ? 0 : saved.revision);
    timeline.supplied = boolean(saved.supplied === undefined ? false : saved.supplied);
    timeline.next_id = integer(saved.next_id === undefined ? 1 : saved.next_id);
    timeline.omitted_tasks = integer(saved.omitted_tasks === undefined ? 0 : saved.omitted_tasks);
    timeline.plan_omitted = integer(saved.plan_omitted === undefined ? 0 : saved.plan_omitted);
    const signature = saved.plan_signature === undefined ? "" : saved.plan_signature;
    if (typeof signature !== "string" || !/^[0-9a-f]{0,16}$/.test(signature)) throw Error("InvalidCheckpoint");
    timeline.plan_signature = signature;
    if (
      timeline.next_id <= greatest ||
      timeline.plan_omitted > timeline.omitted_tasks ||
      timeline.tasks.filter(task => task.source === "agent" && task.present).length > planLimit
    )
      throw Error("InvalidCheckpoint");
    const owner = timeline.tasks.find(task => task.id === timeline.current_task);
    if (
      (owner?.source === "agent" && !owner.present) ||
      (timeline.supplied && owner?.source === "inferred") ||
      (!timeline.supplied && timeline.tasks.some(task => task.source === "agent" && task.present))
    )
      throw Error("InvalidCheckpoint");
    if (!Array.isArray(saved.points) || saved.points.length > 16) throw Error("InvalidCheckpoint");
    let at = 0;
    timeline.points = saved.points.map((value: unknown) => {
      const point = object(value);
      const stamp = integer(point.at, Number.MAX_SAFE_INTEGER);
      const task_id = point.task_id ?? null;
      if (stamp < at || (task_id !== null && (typeof task_id !== "string" || !ids.has(task_id))))
        throw Error("InvalidCheckpoint");
      at = stamp;
      return { at, task_id, label: text(point.label, 4096), usage: usage(point.usage) };
    });
    const retired = object(saved.retired === undefined ? {} : saved.retired);
    if (Object.keys(retired).length > taskLimit) throw Error("InvalidCheckpoint");
    for (const [id, value] of Object.entries(retired)) {
      if (!ids.has(id)) throw Error("InvalidCheckpoint");
      timeline.retired[id] = usage(value);
    }
    timeline.baseline = usage(saved.baseline);
    timeline.turn = text(saved.turn, 4096);
    timeline.open = boolean(saved.open);
    return timeline;
  }
}
