import { List, type Status } from "../../activity/checklist";
import { field, str } from "../common";

/** omp's todo statuses, in Corgi's words. */
const statuses: Record<string, Status> = {
  pending: "pending",
  in_progress: "active",
  blocked: "blocked",
  completed: "done",
  abandoned: "dropped",
};

/** The checklist an omp `todo` result or user edit holds, its phases flattened
 * into groups; `at` is when it was true, in µs. */
export function parse(value: unknown, at = 0): List {
  const phases = field(value, "phases");
  const items: { text: string; status: Status; group: string }[] = [];
  let partial = false;
  for (const phase of Array.isArray(phases) ? phases : []) {
    const tasks = field(phase, "tasks");
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const text = str(task, "content"),
        status = str(task, "status");
      if (!text) continue;
      // An item Corgi can't read may still be open.
      if (!Object.hasOwn(statuses, status)) partial = true;
      else items.push({ text, status: statuses[status], group: str(phase, "name") });
    }
  }
  return List.of(items, partial, at);
}
