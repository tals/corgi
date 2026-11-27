import { field, str, timestampMs } from "../common";
import { List, type Status, type Item } from "../../activity/checklist";
import { Line } from "./transcript";
const statuses: Record<string, Status> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
  deleted: "dropped",
};
const statusOf = (raw: string): Status | null => (Object.hasOwn(statuses, raw) ? statuses[raw] : null);
export class Reader {
  pending = new Map<string, { name: string; input: unknown }>();
  tasks = new Map<string, Item>();
  partial = false;
  record(value: unknown, session: string): List | null {
    const line = Line.of(value, session),
      at = line && timestampMs(line.timestamp);
    if (!line || at === null) return null;
    const content = field(line.message, "content");
    if (!Array.isArray(content)) return null;
    let latest: List | null = null;
    for (const block of content) {
      const type = str(block, "type"),
        name = str(block, "name"),
        id = str(block, "id");
      if (
        line.type === "assistant" &&
        type === "tool_use" &&
        ["TodoWrite", "TaskCreate", "TaskUpdate"].includes(name) &&
        id
      ) {
        if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value!);
        this.pending.set(id, { name, input: field(block, "input") });
      } else if (line.type === "user" && type === "tool_result") {
        const id = str(block, "tool_use_id"),
          call = this.pending.get(id);
        this.pending.delete(id);
        if (!call || field(block, "is_error") === true) continue;
        if (call.name === "TodoWrite") {
          const todos = field(call.input, "todos");
          if (!Array.isArray(todos)) continue;
          let partial = false;
          const items = todos.flatMap(todo => {
            const text = str(todo, "content"),
              status = statusOf(str(todo, "status"));
            if (!text || !status) {
              partial = true;
              return [];
            }
            return [{ text, status }];
          });
          latest = List.of(items, partial, at * 1000);
        } else {
          const raw = field(block, "content"),
            text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(b => str(b, "text")).join("\n") : "";
          const key =
            call.name === "TaskUpdate"
              ? str(call.input, "taskId")
              : text.match(/Task #(\d+) created successfully/)?.[1];
          if (!key) {
            this.partial = true;
            continue;
          }
          const previous = this.tasks.get(key),
            subject = str(call.input, "subject") || previous?.text;
          if (call.name === "TaskUpdate" && !previous) this.partial = true;
          const rawStatus = str(call.input, "status"),
            parsed = statusOf(rawStatus);
          if (rawStatus && !parsed) this.partial = true;
          const status = parsed ?? previous?.status ?? "pending";
          if (!subject) {
            this.partial = true;
            continue;
          }
          this.tasks.set(key, { text: subject, status, group: "" });
          if (this.tasks.size > 64) {
            this.tasks.delete(this.tasks.keys().next().value!);
            this.partial = true;
          }
          latest = List.of([...this.tasks.values()], this.partial, at * 1000);
        }
      }
    }
    return latest;
  }
}
