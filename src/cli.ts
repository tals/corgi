import { realpathSync, statSync } from "node:fs";
import { Connection } from "./rpc";
import { stringify } from "./json";
import { logicalKey } from "./keys";
import helpText from "../assets/cli-help.txt" with { type: "text" };
import skill from "../assets/corgi-skill.md" with { type: "text" };
export const help = helpText;
const groups = new Set(["tab", "pane", "workspace", "current", "list", "focus", "--skill"]);
const nested = new Set(["tab", "pane", "workspace"]);
const flags = new Set(["text", "clear", "stdin", "enter", "new-tab", "left", "right", "up", "down"]);
const options = new Set([
  ...flags,
  "viewer",
  "workspace",
  "name",
  "command",
  "cwd",
  "before",
  "after",
  "width",
  "height",
  "lines",
  "left-of",
  "right-of",
  "above",
  "below",
]);
const actions = new Set([
  "list",
  "current",
  "focus",
  "tab.new",
  "tab.rename",
  "tab.move",
  "tab.merge",
  "tab.close",
  "pane.split",
  "pane.move",
  "pane.swap",
  "pane.resize",
  "pane.close",
  "pane.read",
  "pane.send",
  "pane.keys",
  "workspace.new",
  "workspace.edit",
  "workspace.close",
  "workspace.switch",
]);
export function handles(args: string[]): boolean {
  return groups.has(args[0]);
}
export function id(value: string): number {
  if (!/^\+?\d+$/.test(value)) throw Error("InvalidCharacter");
  const n = Number(value);
  if (n > 0xffffffff) throw Error("Overflow");
  if (!n) throw Error("Usage");
  return n;
}
/** The real path of a directory, relative to this process's cwd. */
export function directory(value: string): string {
  let path: string;
  try {
    path = realpathSync(value);
  } catch {
    throw Error("FileNotFound");
  }
  if (!statSync(path).isDirectory()) throw Error("NotDir");
  return path;
}
class Args {
  options = new Map<string, string>();
  positional: string[] = [];
  constructor(values: string[]) {
    let literal = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!literal && v === "--") literal = true;
      else if (!literal && v.startsWith("--")) {
        const name = v.slice(2);
        if (!options.has(name) || this.options.has(name)) throw Error("Usage");
        if (!flags.has(name) && ++i === values.length) throw Error("Usage");
        this.options.set(name, flags.has(name) ? "" : values[i]);
      } else this.positional.push(v);
    }
  }
  option(name: string): string | null {
    const value = this.options.get(name);
    this.options.delete(name);
    return value ?? null;
  }
  flag(name: string): boolean {
    return this.option(name) !== null;
  }
  required(name: string): string {
    const v = this.option(name);
    if (v === null) throw Error("Usage");
    return v;
  }
  next(): string {
    const v = this.positional.shift();
    if (v === undefined) throw Error("Usage");
    return v;
  }
  end(): void {
    if (this.options.size || this.positional.length) throw Error("Usage");
  }
  directory(value: string): string {
    return directory(value);
  }
  cwd(): string {
    const path = this.option("cwd");
    return path === null ? "" : this.directory(path);
  }
  direction(): string {
    for (const d of ["left", "right", "up", "down"]) if (this.flag(d)) return d;
    throw Error("Usage");
  }
  beside(): object {
    for (const [flag, direction] of [
      ["left-of", "left"],
      ["right-of", "right"],
      ["above", "up"],
      ["below", "down"],
    ]) {
      const other = this.option(flag);
      if (other !== null) return { other: id(other), direction };
    }
    throw Error("Usage");
  }
}
export async function parse(words: string[], caller = 0, input?: () => Promise<string>): Promise<any> {
  const group = words[0];
  if (!groups.has(group)) throw Error("Usage");
  let start = nested.has(group) ? 2 : 1;
  const raw = nested.has(group) ? `${group}.${words[1]}` : group;
  const action = raw === "workspace.list" ? "list" : raw;
  if (!actions.has(action)) throw Error("Usage");
  let current = false,
    target = 0;
  if (!["list", "current", "tab.new", "workspace.new"].includes(action)) {
    if (start === words.length) throw Error("Usage");
    current = words[start] === "current";
    if (current && group === "workspace") throw Error("Usage");
    if (current && !caller) throw Error("NoCallerPane");
    target = current ? caller : id(words[start]);
    start++;
  }
  const args = new Args(words.slice(start)),
    text_mode = args.flag("text");
  const viewer =
    action === "focus"
      ? id(args.required("viewer"))
      : action === "workspace.switch"
        ? args.options.has("viewer")
          ? id(args.required("viewer"))
          : null
        : null;
  let command: Record<string, any> | null = null;
  const set = (op: string, payload: any) => {
    command = { [op]: payload };
  };
  switch (action) {
    case "list":
    case "current":
    case "focus":
    case "workspace.switch":
      break;
    case "tab.new":
      set("pane.create", {
        workspace: args.options.has("workspace") ? id(args.required("workspace")) : 0,
        title: args.option("name") ?? "",
        cwd: args.cwd(),
        command: args.option("command"),
      });
      break;
    case "workspace.new":
      set("workspace.create", { name: args.next(), cwd: args.directory(args.option("cwd") ?? ".") });
      break;
    case "workspace.close":
      set(action, { target });
      break;
    case "workspace.edit":
      set(action, {
        target,
        name: args.flag("clear") ? "" : args.option("name"),
        cwd: args.options.has("cwd") ? args.directory(args.required("cwd")) : null,
      });
      break;
    case "tab.rename":
      set(action, { target, name: args.flag("clear") ? "" : args.next() });
      break;
    case "tab.close":
    case "pane.close":
      set(action, { target });
      break;
    case "pane.swap":
      set(action, { target, other: id(args.next()) });
      break;
    case "pane.split":
      set(action, { target, direction: args.direction(), cwd: args.cwd(), command: args.option("command") });
      break;
    case "tab.merge":
      set(action, { target, ...args.beside() });
      break;
    case "tab.move":
      set(action, {
        target,
        destination: args.options.has("before")
          ? { before: id(args.required("before")) }
          : args.options.has("after")
            ? { after: id(args.required("after")) }
            : { workspace: id(args.required("workspace")) },
      });
      break;
    case "pane.move":
      set(action, {
        target,
        destination: args.flag("new-tab") ? { new_tab: args.option("name") ?? "" } : { beside: args.beside() },
      });
      break;
    case "pane.resize": {
      const width = args.option("width"),
        value = width ?? args.required("height");
      if (!/^\d+%$/.test(value)) throw Error("Usage");
      const percent = Number(value.slice(0, -1));
      if (percent < 10 || percent > 90) throw Error("Usage");
      set(action, { target, axis: width === null ? "vertical" : "horizontal", ratio: percent * 10 });
      break;
    }
    case "pane.read": {
      const value = args.option("lines") ?? "100";
      if (!/^\d+$/.test(value)) throw Error("InvalidCharacter");
      const lines = Number(value);
      if (!lines || lines > 10000) throw Error("Usage");
      set(action, { target, lines });
      break;
    }
    case "pane.send": {
      let text: string;
      if (args.flag("stdin")) {
        text = await (input ? input() : Bun.stdin.text());
        if (Buffer.byteLength(text) > 1024 * 1024) throw Error("StreamTooLong");
      } else text = args.next();
      set(action, { target, text, enter: args.flag("enter") });
      break;
    }
    case "pane.keys":
      if (!args.positional.length) throw Error("Usage");
      for (const key of args.positional) logicalKey(key);
      set(action, { target, text: args.positional.join(" ") });
      args.positional = [];
      break;
  }
  args.end();
  if (action === "current" && !caller) throw Error("NoCallerPane");
  const created = (command as Record<string, any> | null)?.["pane.create"];
  if (created?.workspace === 0 && !caller) throw Error("MissingWorkspace");
  return { action, target, current, text_mode, viewer, command };
}
export async function run(path: string, args: string[]): Promise<void> {
  const group = args[0];
  if (group === "--skill") {
    if (args.length !== 1) throw Error("Usage");
    process.stdout.write(skill);
    return;
  }
  if ((nested.has(group) && args.length === 1) || args.slice(1).some(v => v === "--help" || v === "-h")) {
    process.stdout.write(help);
    return;
  }
  const caller = Number(process.env.CORGI_PANE) || 0,
    inv = await parse(args, caller),
    conn = new Connection(path);
  try {
    if ((inv.current && group === "tab") || (inv.action === "tab.new" && caller)) {
      const { result } = await conn.call("session.locate", { pane: caller });
      const [op, q] = Object.entries(inv.command)[0] as [string, any];
      if (op === "pane.create") {
        q.workspace ||= result.workspace;
        if (q.workspace === result.workspace) q.from = caller;
      } else q.target = result.tab;
    }
    const reply = inv.command
      ? await conn.call("session.command", { command: inv.command })
      : inv.action === "list"
        ? await conn.call("session.list")
        : inv.action === "current"
          ? await conn.call("session.locate", { pane: caller })
          : inv.action === "workspace.switch"
            ? await conn.call("workspace.switch", { workspace: inv.target, viewer: inv.viewer })
            : await conn.call("focus", { pane: inv.target, viewer: inv.viewer });
    if (inv.text_mode && typeof reply.result?.text === "string") process.stdout.write(reply.result.text);
    else process.stdout.write(stringify(reply, inv.text_mode ? 2 : undefined) + "\n");
  } finally {
    conn.close();
  }
}
export function failure(code: string, status = 1): void {
  process.stderr.write(stringify({ ok: false, err: code }) + "\n");
  process.exitCode = status;
}
