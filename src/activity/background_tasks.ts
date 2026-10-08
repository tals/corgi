import path from "node:path";
import { Text, field, str } from "../providers/common";
export const capacity = 32;
export type Group = "tests" | "builds" | "servers" | "commands";
export const Group = {
  label: (g: Group) =>
    ({
      tests: "Tests",
      builds: "Builds",
      servers: "Servers",
      commands: "Commands",
    })[g],
};
export type Task = { id: Text; label: Text; group: Group };
export function claudeTask(item: any) {
  if (["completed", "failed", "killed"].includes(str(item, "status")))
    return null;
  const t = str(item, "type");
  return ["shell", "subagent"].includes(t) ? t : null;
}
export function classify(command: string): Group {
  const words = command.trim().split(/\s+/),
    exe = path.basename(words.shift() ?? "");
  if (["pytest", "jest", "vitest"].includes(exe)) return "tests";
  for (let i = 0; i < 2; i++) {
    const w = words.shift();
    if (!w) break;
    if (w === "test" || (w === "pytest" && exe.startsWith("python")))
      return "tests";
    if (w === "build") return words.shift() === "test" ? "tests" : "builds";
    if (["dev", "serve", "http.server"].includes(w)) return "servers";
    if (!["run", "-m"].includes(w)) break;
  }
  return "commands";
}
export function summarize(description: string, command: string, group: Group) {
  const prose = description.trim();
  if (prose && prose !== command.trim()) {
    let label = "";
    const words = prose.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      if (
        i === 6 ||
        Buffer.byteLength(label) + Buffer.byteLength(word) + Number(!!label) >
          45
      ) {
        if (label) return label + "…";
        break;
      }
      label += (label ? " " : "") + word;
    }
    if (label) return label;
  }
  if (group === "tests") return "Running tests";
  if (group === "builds") return "Building project";
  if (group === "servers") return "Running development server";
  const exe = path.basename(command.trim().split(/\s+/)[0] ?? "");
  return (
    (
      {
        rg: "Searching files",
        grep: "Searching files",
        find: "Searching files",
        curl: "Fetching data",
        wget: "Fetching data",
        sleep: "Waiting",
        wait: "Waiting",
        tail: "Watching output",
        git: "Running Git task",
        bun: "Running Bun task",
        node: "Running JavaScript task",
      } as Record<string, string>
    )[exe] ??
    (exe.startsWith("python") ? "Running Python task" : "Running shell task")
  );
}
export class Inventory {
  items: Task[] = [];
  observed_at = 0;
  live = false;
  truncated = false;
  get len() {
    return this.items.length;
  }
  append(id: string, description: string, command: string) {
    if (
      !id ||
      Buffer.byteLength(id) > 96 ||
      (!description && !command) ||
      this.items.some((t) => t.id.text() === id)
    )
      return;
    if (this.len === capacity) {
      this.truncated = true;
      return;
    }
    const group = classify(command);
    this.items.push({
      id: new Text(id),
      label: new Text(summarize(description, command, group).slice(0, 256)),
      group,
    });
  }
  static claude(value: any, now: number) {
    if (!Array.isArray(value)) return null;
    const t = new Inventory();
    t.observed_at = now;
    for (const item of value)
      if (claudeTask(item) === "shell")
        t.append(
          str(item, "id"),
          str(item, "description"),
          str(item, "command"),
        );
    return t;
  }
  view() {
    return {
      items: this.items.map((t) => ({
        id: t.id.text(),
        label: t.label.text(),
        group: t.group,
      })),
      observed_at: this.observed_at,
      live: this.live,
      truncated: this.truncated,
    };
  }
}
export class Children {
  items: Array<{ id: Text; description: Text; agent_type: Text }> = [];
  running = 0;
  get len() {
    return this.items.length;
  }
  slice() {
    return this.items;
  }
  listed(id: string) {
    return this.items.some((c) => c.id.text() === id);
  }
  complete() {
    return this.running === this.len;
  }
  static claude(value: any) {
    if (!Array.isArray(value)) return null;
    const out = new Children();
    for (const item of value) {
      if (claudeTask(item) !== "subagent") continue;
      const id = str(item, "id");
      if (!id || Buffer.byteLength(id) > 96 || out.listed(id)) continue;
      out.running = Math.min(0xffffffff, out.running + 1);
      if (out.len === capacity) continue;
      out.items.push({
        id: new Text(id),
        description: new Text(str(item, "description").slice(0, 160)),
        agent_type: new Text(str(item, "agent_type").slice(0, 80)),
      });
    }
    return out;
  }
}
export class Ended {
  static limit = 16;
  items: Text[] = [];
  get len() {
    return this.items.length;
  }
  add(id: string) {
    if (!id || Buffer.byteLength(id) > 32 || this.listed(id)) return;
    if (this.len === Ended.limit) this.items.shift();
    this.items.push(new Text(id));
  }
  listed(id: string) {
    return this.items.some((t) => t.text() === id);
  }
}
/** The background shells a Claude Stop lists as running: commands and
 * Monitors alike. Each one's end, and each event a Monitor prints, wakes
 * the conversation. */
export class Shells {
  items: Text[] = [];
  get len() {
    return this.items.length;
  }
  /** Empty when the Stop lists no work at all. */
  static claude(value: any): Shells {
    const out = new Shells();
    if (!Array.isArray(value)) return out;
    for (const item of value) {
      if (claudeTask(item) !== "shell") continue;
      const id = str(item, "id");
      if (!id || Buffer.byteLength(id) > 32 || out.listed(id) || out.len === capacity) continue;
      out.items.push(new Text(id));
    }
    return out;
  }
  /** Drops the shells the transcript reports ended. */
  drop(ended: Ended) {
    this.items = this.items.filter((t) => !ended.listed(t.text()));
  }
  slice() {
    return this.items;
  }
  listed(id: string) {
    return this.items.some((t) => t.text() === id);
  }
}
export function claudeWakeup(crons: any) {
  return (
    Array.isArray(crons) && crons.some((c) => field(c, "recurring") === false)
  );
}
