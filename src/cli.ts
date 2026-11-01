import { realpathSync, statSync } from "node:fs";
import { Connection } from "./rpc";
import { stringify } from "./json";
import { logicalKey } from "./keys";
import { Provider, adapter } from "./providers";
import type { CommandInput } from "./protocol";
import type { Agent as ConfiguredAgent } from "./launcher_config";
import * as launcherOrder from "./launch/order";
import * as effort from "./providers/effort";
import { Row } from "./launch/row";
import { Entry as CommandEntry } from "./launch/command";
import helpText from "../assets/cli-help.txt" with { type: "text" };
import * as i18n from "./i18n";
import skill from "../assets/corgi-skill.md" with { type: "text" };
export const help = helpText;
export function localizedHelp(): string {
  return i18n.document(helpText);
}
const groups = new Set(["tab", "pane", "workspace", "launcher", "claim", "current", "list", "focus", "--skill"]);
const nested = new Set(["tab", "pane", "workspace", "launcher"]);
const flags = new Set(["json", "clear", "stdin", "enter", "new-tab", "first", "left", "right", "up", "down"]);
const options = new Set([
  ...flags,
  "model",
  "effort",
  "flags",
  "env",
  "yolo",
  "from",
  "viewer",
  "pane",
  "owner",
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
  "pane.idle",
  "claim",
  "workspace.new",
  "workspace.edit",
  "workspace.close",
  "workspace.switch",
  "launcher.edit",
  "launcher.clone",
  "launcher.move",
  "launcher.copy",
  "launcher.models",
  "launcher.remove",
  "launcher.add",
  "launcher.list",
  "launcher.hide",
  "launcher.show",
]);
export function handles(args: string[]): boolean {
  return groups.has(args[0]);
}
/** Help flags in a full command line before `--`, excluding its option values. */
export function asksHelp(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
    const name = arg.startsWith("--") ? arg.slice(2) : "";
    switch (args[0]) {
      case "account":
        if (args[1] === "add" && name === "dir") i++;
        break;
      case "integration":
        if (name === "account") i++;
        break;
      case "headless":
        if (args[1] === "start" && i === 4 && name === "workspace") i++;
        break;
      default:
        if (handles(args) && args[0] !== "--skill" && options.has(name) && !flags.has(name)) i++;
        break;
    }
  }
  return false;
}
/** The lines of a help text that show the command a line names, matched by
 * its longest run of leading words: `pane split 3` finds `corgi pane split`. */
export function usage(text: string, args: string[]): string[] {
  const end = args.findIndex((arg, i) => i > 0 && arg.startsWith("-")),
    words = end === -1 ? args : args.slice(0, end);
  for (let n = words.length; n > 0; n--) {
    let matched = false;
    const prefix = ["corgi", ...words.slice(0, n)].join(" "),
      lines = text.split("\n").filter(line => {
        if (matched && line.startsWith("    ")) return true;
        const shown = line.trimStart();
        matched = shown.startsWith(prefix) && [undefined, " ", "|"].includes(shown[prefix.length]);
        return matched;
      });
    if (lines.length) return lines;
  }
  return [];
}
/** A command's usage, or the full reference when no command was named. */
export function helpFor(text: string, args: string[], agent = false): string {
  const lines = usage(text, args);
  const label = agent ? "Usage:" : i18n.t`Usage:`;
  return lines.length ? `${label}\n${lines.join("\n")}\n` : text;
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
  if (group !== "launcher" && !["list", "current", "tab.new", "workspace.new", "pane.idle", "claim"].includes(action)) {
    if (start === words.length) throw Error("Usage");
    current = words[start] === "current";
    if (current && group === "workspace") throw Error("Usage");
    if (current && !caller) throw Error("NoCallerPane");
    target = current ? caller : id(words[start]);
    start++;
  }
  const args = new Args(words.slice(start)),
    json = args.flag("json");
  const viewer =
    action === "focus"
      ? id(args.required("viewer"))
      : action === "workspace.switch"
        ? args.options.has("viewer")
          ? id(args.required("viewer"))
          : null
        : null;
  let command: Record<string, any> | null = null,
    idle: { workspace: number; cwd: string; first: boolean } | null = null,
    launcher: {
      workspace: number;
      agents: string[];
      before?: string | null;
      after?: string | null;
      first?: boolean;
      from?: number;
      edit?: Record<string, string | boolean | null>;
      command?: string;
      name?: string;
    } | null = null,
    claim: { pane: number; provider: Provider | null; owner: number } | null = null;
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
    case "launcher.list":
    case "launcher.hide":
    case "launcher.show":
    case "launcher.edit":
    case "launcher.clone":
    case "launcher.move":
    case "launcher.copy":
    case "launcher.models":
    case "launcher.remove":
    case "launcher.add": {
      launcher = { workspace: args.options.has("workspace") ? id(args.required("workspace")) : 0, agents: [] };
      if (action === "launcher.copy") launcher.from = id(args.required("from"));
      else if (action === "launcher.add") {
        launcher.command = args.required("command");
        launcher.name = args.option("name") ?? "";
      } else if (action !== "launcher.list") {
        launcher.agents =
          action === "launcher.hide" || action === "launcher.show" ? args.positional.splice(0) : [args.next()];
        if (!launcher.agents.length) throw Error("Usage");
      }
      if (action === "launcher.move") {
        launcher.before = args.option("before");
        launcher.after = args.option("after");
        launcher.first = args.flag("first");
        if (Number(launcher.before !== null) + Number(launcher.after !== null) + Number(launcher.first) > 1)
          throw Error("Usage");
      }
      if (action === "launcher.edit" || action === "launcher.clone") {
        const yolo = args.option("yolo"),
          level = args.option("effort");
        if (yolo !== null && yolo !== "on" && yolo !== "off") throw Error("Usage");
        if (level !== null && level !== "default" && !effort.parse(level)) throw Error("Usage");
        launcher.edit = {
          name: args.option("name"),
          model: args.option("model"),
          effort: level,
          flags: args.option("flags"),
          env: args.option("env"),
          yolo: yolo === null ? null : yolo === "on",
        };
        const command = args.option("command");
        if (command !== null) launcher.command = command;
      }
      break;
    }
    case "claim": {
      const clear = args.flag("clear");
      const provider = clear ? null : Provider.parse(args.next());
      if (!clear && !provider) throw Error("Usage");
      const pane = args.option("pane") ?? "current";
      if (pane === "current" && !caller) throw Error("NoCallerPane");
      claim = {
        pane: pane === "current" ? caller : id(pane),
        provider,
        owner: id(args.option("owner") ?? String(process.ppid)),
      };
      if (claim.owner <= 1 || claim.owner > 0x7fffffff) throw Error("Usage");
      break;
    }
    case "pane.idle":
      idle = {
        workspace: args.options.has("workspace") ? id(args.required("workspace")) : 0,
        cwd: args.cwd(),
        first: args.flag("first"),
      };
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
  if (launcher && action !== "launcher.list" && action !== "launcher.models" && !launcher.workspace && !caller)
    throw Error("MissingWorkspace");
  return { action, target, current, json, viewer, command, idle, launcher, ...(claim ? { claim } : {}) };
}
/** A tab's split tree from the layout's node array, in words: `3 left of (4
 * above 5)`. */
export function layout(nodes: any[], index: number, nested = false): string {
  const node = nodes[index];
  if (!node) return "";
  if ("pane" in node) return String(node.pane);
  const first = layout(nodes, node.split.first, true),
    second = layout(nodes, node.split.second, true);
  if (!first || !second) return first || second;
  const text = `${first} ${node.split.axis === "horizontal" ? "left of" : "above"} ${second}`;
  return nested ? `(${text})` : text;
}
/** The pane IDs of a tab's split tree, left to right and top to bottom. */
function panes(nodes: any[], index: number): number[] {
  const node = nodes[index];
  if (!node) return [];
  if ("pane" in node) return [node.pane];
  return [...panes(nodes, node.split.first), ...panes(nodes, node.split.second)];
}
const quote = (name: string) => (name ? " " + JSON.stringify(name) : "");
/** `corgi list` as an outline: workspaces, their tabs and panes, then viewers.
 * A pane shows its cwd only where it differs from its workspace's. */
export function list(reply: any): string {
  const out: string[] = [],
    byId = new Map<number, any>((reply.result?.panes ?? []).map((p: any) => [p.id, p]));
  for (const w of reply.result?.workspaces ?? []) {
    out.push(`workspace ${w.id}${quote(w.name)} ${w.cwd}`);
    for (const t of w.model?.tabs ?? []) {
      const ids = panes(w.model.nodes, t.root);
      out.push(`  tab ${t.id}${quote(t.title)}${ids.length > 1 ? ": " + layout(w.model.nodes, t.root) : ""}`);
      for (const id of ids) {
        const p = byId.get(id);
        if (p) out.push(`    pane ${id}${quote(p.name)}${p.cwd && p.cwd !== w.cwd ? " " + p.cwd : ""}${pane(p)}`);
      }
    }
  }
  for (const v of reply.viewers ?? []) out.push(`viewer ${v.id}: workspace ${v.workspace}, pane ${v.pane}`);
  return out.join("\n") + "\n";
}
function pane(p: any): string {
  const a = p.agent,
    exited = p.exited ? " exited" : "";
  if (!a?.provider) return exited;
  const attention = a.attention && a.attention !== "none" ? ", " + a.attention.replace("_", " ") : "",
    activity = a.activity || a.recent_activity;
  return `${exited} ${a.provider} ${a.state}${attention}${quote(a.name)}${activity ? ` (${activity})` : ""}`;
}
/** `pane idle`: each shell waiting at its prompt, with its folder. */
export function idle(reply: any): string {
  const panes: any[] = reply.panes ?? [];
  if (!panes.length) return "no idle shells\n";
  return panes.map(p => `pane ${p.pane} (tab ${p.tab}, workspace ${p.workspace}) ${p.cwd}\n`).join("");
}
/** A launcher row as `launcher` commands name it, `codex`, `claude/work` or
 * `command/2`, with the other names it answers to and whether it's in the
 * launcher at all. */
type LauncherAgent = {
  agent: string;
  names: string[];
  label: string;
  row: Row;
  launcher: boolean;
  options?: ConfiguredAgent["options"];
  yolo?: boolean;
};
/** Whether each agent shows in one workspace's launcher. */
export type LauncherWorkspace = {
  id: number;
  name: string;
  agents: {
    agent: string;
    label: string;
    launcher: boolean;
    hidden: boolean;
    options?: ConfiguredAgent["options"];
    yolo?: boolean;
  }[];
};
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(v => typeof v === "string") : []);
/** The launcher's rows in a snapshot, but the terminal's. */
function launcherAgents(snapshot: any): LauncherAgent[] {
  if (snapshot.launcher_agents) return snapshot.launcher_agents;
  const accounts: any[] = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [],
    hidden = strings(snapshot?.account_hidden);
  const agents = Provider.all.flatMap((provider): LauncherAgent[] => [
    {
      agent: provider,
      names: [`${provider}/default`],
      label: adapter(provider).label,
      row: Row.of(provider),
      launcher: snapshot?.agent_hidden?.[provider] !== true,
    },
    ...accounts
      .filter(a => a?.provider === provider && typeof a.account === "string" && typeof a.name === "string")
      .map(a => ({
        agent: `${provider}/${a.name}`,
        names: [a.name],
        label: `${adapter(provider).label} · ${a.name}`,
        row: Row.of(provider, a.account),
        launcher: !hidden.includes(a.account),
      })),
  ]);
  const commands = (Array.isArray(snapshot?.agent_commands) ? snapshot.agent_commands : []).flatMap(
    (value: any, index: number): LauncherAgent[] => {
      const entry = Object.assign(new CommandEntry(), value ?? {});
      if (typeof entry.command !== "string" || !entry.command) return [];
      return [
        {
          agent: `command/${index + 1}`,
          names: entry.name ? [entry.name] : [],
          label: entry.label(),
          row: Row.ofCommand(index),
          launcher: entry.hidden !== true,
        },
      ];
    },
  );
  return [...agents, ...commands];
}
/** A canonical name and an alias must identify the same single agent. */
function launcherAgent(agents: LauncherAgent[], name: string): LauncherAgent {
  const matches = agents.filter(a => a.agent === name || a.names.includes(name));
  if (matches.length > 1) throw Error("AmbiguousAgent");
  if (!matches.length) throw Error("UnknownAgent");
  return matches[0];
}
/** Each workspace's launcher, or only `workspace`'s, with the agents `names`
 * spell or every one. */
export function launcher(snapshot: any, workspace = 0, names: string[] = []): LauncherWorkspace[] {
  const agents = launcherAgents(snapshot),
    picked = names.length ? [...new Set(names.map(name => launcherAgent(agents, name)))] : agents,
    workspaces: any[] = (snapshot?.workspaces ?? []).filter((w: any) => !workspace || w.id === workspace);
  if (!workspaces.length) throw Error("NoWorkspace");
  return workspaces.map(w => ({
    id: w.id,
    name: w.name ?? "",
    agents: launcherOrder
      .arrange(
        picked.map(a => a.row),
        strings(w.launcher_order) as Row[],
      )
      .map(row => picked.find(a => a.row === row)!)
      .map(a => ({
        agent: a.agent,
        label: a.label,
        launcher: a.launcher,
        hidden: strings(w.launcher_hidden).includes(a.row),
        ...(a.options ? { options: a.options, yolo: a.yolo } : {}),
      })),
  }));
}
/** `launcher` replies as an outline: each workspace, then its agents and whether each shows there. */
export function launcherText(workspaces: LauncherWorkspace[]): string {
  const all = workspaces.flatMap(w => w.agents),
    names = Math.max(...all.map(a => a.agent.length)),
    labels = Math.max(...all.map(a => a.label.length)),
    out: string[] = [];
  for (const w of workspaces) {
    out.push(`workspace ${w.id}${quote(w.name)}`);
    for (const a of w.agents)
      out.push(
        `  ${a.agent.padEnd(names)}  ${a.label.padEnd(labels)}  ${!a.launcher ? "not in the launcher" : a.hidden ? "hidden" : "shown"}${a.options ? `  ${a.options.model ?? "Auto (last chosen)"} / ${a.options.effort ?? "Default"}` : ""}`,
      );
  }
  return out.join("\n") + "\n";
}
/** Runs `launcher list`, or `hide` or `show`, which change one workspace and
 * then read back what it shows of the agents they name. */
async function launcherCommand(conn: Connection, inv: any, caller: number): Promise<LauncherWorkspace[]> {
  const q = inv.launcher,
    before = (await conn.call("session.list")).result,
    agents = (await conn.call("launcher.catalog")).agents;
  const read = async (workspace: number) =>
    launcher(
      { ...(await conn.call("session.list")).result, launcher_agents: (await conn.call("launcher.catalog")).agents },
      workspace,
    );
  if (inv.action === "launcher.list") return launcher({ ...before, launcher_agents: agents }, q.workspace);
  const chosen: LauncherAgent[] = q.agents.map((name: string) => launcherAgent(agents, name));
  if (inv.action === "launcher.models") {
    const { models } = await conn.call("launcher.models", { row: chosen[0].row });
    process.stdout.write(
      inv.json
        ? stringify({ ok: true, models }) + "\n"
        : models
            .map(
              m =>
                `${m.id}  ${m.name}  ${m.efforts?.join(", ") ?? ""}${m.default_effort ? ` (default: ${m.default_effort})` : ""}`,
            )
            .join("\n") + "\n",
    );
    return [];
  }
  const workspace = q.workspace || (await conn.call("session.locate", { pane: caller })).result.workspace;
  launcher(before, workspace);
  const send = (command: CommandInput) => conn.call("session.command", { command });
  switch (inv.action) {
    case "launcher.copy":
      await send({ "agent.launcher.copy": { from: q.from, workspace } });
      break;
    case "launcher.move": {
      const ordered = launcherOrder.arrange(
          agents.map(a => a.row),
          before.workspaces.find(w => w.id === workspace)!.launcher_order as Row[],
        ),
        row = chosen[0].row,
        others = ordered.filter(r => r !== row);
      let target = q.before ? launcherAgent(agents, q.before).row : null;
      if (q.after) {
        const after = launcherAgent(agents, q.after).row;
        if (after === row) throw Error("Usage");
        target = others[others.indexOf(after) + 1] ?? null;
      }
      if (q.first) target = others[0] ?? null;
      await send({
        "agent.launcher.move": {
          workspace,
          row,
          before: target,
          order: ordered,
          shown: !before.workspaces.find(w => w.id === workspace)!.launcher_hidden.includes(row),
        },
      });
      break;
    }
    case "launcher.hide":
    case "launcher.show":
      for (const agent of chosen) {
        if (inv.action === "launcher.show" && !agent.launcher) {
          const native = Row.launch(agent.row),
            index = Row.custom(agent.row);
          if (native) {
            if (!native.account) before.agent_hidden[native.provider] = false;
            before.account_hidden = before.account_hidden.filter(a => a !== native.account);
            await send({
              "agent.visibility": {
                hidden: { ...before.agent_hidden, ...(!native.account ? { [native.provider]: false } : {}) },
                hidden_accounts: before.account_hidden.filter(a => a !== native.account),
              },
            });
          } else if (index !== null)
            await send({
              "agent.command": { index, command: before.agent_commands[index].command, hidden: false, resolve: false },
            });
        }
        await send({
          "agent.workspace_visibility": { workspace, row: agent.row, shown: inv.action === "launcher.show" },
        });
      }
      break;
    case "launcher.remove":
      await send({ "agent.launcher.remove": { row: chosen[0].row } });
      break;
    case "launcher.add":
    case "launcher.edit":
    case "launcher.clone": {
      const original = chosen[0],
        index = original ? Row.custom(original.row) : null;
      if (inv.action === "launcher.add" || index !== null) {
        if (q.edit && ["model", "effort", "flags", "env", "yolo"].some(k => q.edit[k] !== null))
          throw Error("CustomCommandOptions");
        const slot = inv.action === "launcher.edit" ? index : before.agent_commands.findIndex(e => !e.command);
        if (slot === null || slot < 0) throw Error("NoCommandSlots");
        const source = index !== null ? before.agent_commands[index] : null;
        await send({
          "agent.command": {
            index: slot,
            command: q.command ?? source?.command ?? "",
            name:
              q.edit?.name ??
              q.name ??
              (inv.action === "launcher.clone" ? `${original.label} copy` : (source?.name ?? "")),
            ...(source && q.command === undefined ? { original: source.original, semantics: source.semantics } : {}),
            resolve: q.command !== undefined,
            hidden: inv.action === "launcher.edit" ? (source?.hidden ?? false) : false,
          },
        });
      } else {
        if (q.command !== undefined) throw Error("Usage");
        await send({
          "agent.launcher.configure": { row: original.row, clone: inv.action === "launcher.clone", ...q.edit },
        });
      }
      break;
    }
  }
  const result = await read(workspace);
  return inv.action === "launcher.hide" || inv.action === "launcher.show"
    ? result.map(w => ({ ...w, agents: w.agents.filter(a => chosen.some(c => c.agent === a.agent)) }))
    : result;
}
/** A reply other than `list`, `pane idle` and `pane read`, in words. */
export function words(reply: any): string {
  if ("queued" in reply) return `queued for viewer ${reply.viewer}\n`;
  const r = reply.result ?? {};
  if (r.closed_panes?.length) return `closed pane ${r.closed_panes.join(", ")}\n`;
  if (r.pane) return `pane ${r.pane} (tab ${r.tab}, workspace ${r.workspace})\n`;
  return "ok\n";
}
/** `pane read` text for a reader that asked for `lines` lines, given up to one
 * more: the extra line only says that earlier output exists. Agent mode trims
 * line ends, shortens rules and keeps one blank line in a row. */
export function read(text: string, lines: number, agent = false): string {
  let all = text.split("\n");
  const more = all.length > lines;
  if (more) all = all.slice(-lines);
  if (agent)
    all = all
      .map(line => line.trimEnd().replace(/[─━═]{4,}/g, m => m.slice(0, 3)))
      .filter((line, i, kept) => line || kept[i - 1] !== "");
  const shown = all.join("\n"),
    header = more ? `[corgi: last ${lines} lines shown; --lines N reads more]\n` : "";
  return header + shown + (shown ? "\n" : "");
}
/** Runs a control command and prints its reply in words, or with `--json` as
 * the daemon sent it. */
export async function run(path: string, args: string[], agent = false): Promise<void> {
  const group = args[0];
  if ((nested.has(group) && args.length === 1) || asksHelp(args)) {
    process.stdout.write(helpFor(agent ? help : localizedHelp(), args, agent));
    return;
  }
  if (group === "--skill") {
    if (args.length !== 1) throw Error("Usage");
    process.stdout.write(skill);
    return;
  }
  const caller = Number(process.env.CORGI_PANE) || 0,
    inv = await parse(args, caller),
    conn = new Connection(path);
  const reading = inv.json ? null : inv.command?.["pane.read"],
    lines = reading?.lines;
  if (reading) reading.lines = Math.min(lines + 1, 10000);
  try {
    if (inv.claim) {
      const reply = await conn.call("pane.agent", inv.claim);
      process.stdout.write(inv.json ? stringify(reply) + "\n" : words(reply));
      return;
    }
    if (inv.launcher) {
      const workspaces = await launcherCommand(conn, inv, caller);
      if (inv.action === "launcher.models") return;
      process.stdout.write(inv.json ? stringify({ ok: true, workspaces }) + "\n" : launcherText(workspaces));
      return;
    }
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
          : inv.action === "pane.idle"
            ? await conn.call("pane.idle", inv.idle)
            : inv.action === "workspace.switch"
              ? await conn.call("workspace.switch", { workspace: inv.target, viewer: inv.viewer })
              : await conn.call("focus", { pane: inv.target, viewer: inv.viewer });
    if (inv.json) process.stdout.write(stringify(reply) + "\n");
    else if (reading && "result" in reply && "text" in reply.result && typeof reply.result.text === "string")
      process.stdout.write(read(reply.result.text, lines, agent));
    else
      process.stdout.write(
        inv.action === "list" ? list(reply) : inv.action === "pane.idle" ? idle(reply) : words(reply),
      );
  } finally {
    conn.close();
  }
}
/** Writes a failed command line's error, as JSON when it asked for `--json`;
 * a usage error lists the command's help lines. */
export function failure(code: string, status = 1, args: string[] = []): void {
  const lines = code === "Usage" ? usage(help, args).map(line => line.trim()) : [],
    end = args.indexOf("--");
  if ((end === -1 ? args : args.slice(0, end)).includes("--json"))
    process.stderr.write(stringify({ ok: false, err: code, ...(lines.length ? { usage: lines } : {}) }) + "\n");
  else if (lines.length) process.stderr.write(`corgi: usage:\n${lines.map(line => "  " + line).join("\n")}\n`);
  else process.stderr.write(`corgi: ${code}\n`);
  process.exitCode = status;
}
