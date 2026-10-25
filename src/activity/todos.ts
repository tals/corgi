//! OMP's durable todo snapshots, shared by the transcript reader and agent card.
export type Status = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export interface Item {
  content: string;
  status: Status;
  blocker?: string;
}
export interface Phase {
  name: string;
  tasks: Item[];
}
/** Reject malformed snapshots without replacing the last valid list. */
export function phases(value: unknown): Phase[] | null {
  if (!Array.isArray(value)) return null;
  const out: Phase[] = [];
  for (const phase of value) {
    if (!phase || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    const tasks: Item[] = [];
    for (const task of phase.tasks) {
      if (!task || typeof task.content !== "string") return null;
      switch (task.status) {
        case "pending":
        case "in_progress":
        case "completed":
        case "abandoned":
        case "blocked":
          tasks.push({
            content: task.content,
            status: task.status,
            ...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
          });
          break;
        default:
          return null;
      }
    }
    out.push({ name: phase.name, tasks });
  }
  return out;
}
