import path from "node:path";
import { Text } from "../providers/common";
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
export function classify(command: string): Group {
  const words = command.trim().split(/\s+/);
  // Environment assignments before the command, as in `JOBS=4 bun test`.
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  const exe = path.basename(words.shift() ?? "");
  if (["pytest", "jest", "vitest"].includes(exe)) return "tests";
  for (let i = 0; i < 2; i++) {
    // A package script's variant, as in `bun run test:unit`, keeps its kind.
    const w = words.shift()?.split(":")[0];
    if (!w) break;
    if (w === "test" || (w === "pytest" && exe.startsWith("python"))) return "tests";
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
      if (i === 6 || Buffer.byteLength(label) + Buffer.byteLength(word) + Number(!!label) > 45) {
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
    )[exe] ?? (exe.startsWith("python") ? "Running Python task" : "Running shell task")
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
    if (!id || Buffer.byteLength(id) > 96 || (!description && !command) || this.items.some(t => t.id.text() === id))
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
  view() {
    return {
      items: this.items.map(t => ({
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
    return this.items.some(c => c.id.text() === id);
  }
  complete() {
    return this.running === this.len;
  }
  without(id: string) {
    const kept = this.items.filter(c => c.id.text() !== id);
    this.running -= this.len - kept.length;
    this.items = kept;
    return this;
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
    return this.items.some(t => t.text() === id);
  }
}
/** Background shells a conversation runs. */
export class Shells {
  items: Text[] = [];
  get len() {
    return this.items.length;
  }
  /** Drops the shells the transcript reports ended. */
  drop(ended: Ended) {
    this.items = this.items.filter(t => !ended.listed(t.text()));
  }
  slice() {
    return this.items;
  }
  listed(id: string) {
    return this.items.some(t => t.text() === id);
  }
}
