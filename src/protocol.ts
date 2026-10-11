import { object } from "./json";
import { Theme } from "./theme";
import type { View as SurfaceView } from "./pane/surface";
export interface Control {
  seq: number;
  kind: "focus" | "workspace" | "action";
  id?: number;
  name?: string;
  value?: string;
}
export interface Opened {
  viewer_protocol: number;
  bell_seq: number | bigint;
  workspace: number;
}
export interface View<Session = unknown, Resources = unknown> {
  type: "view";
  viewer_protocol: number;
  session: Session | null;
  session_hash: number | bigint;
  resources: Resources | null;
  resources_hash: number | bigint;
  surfaces: SurfaceView[];
  bell_seq: number | bigint;
  bell_kind: "none" | "finished" | "needs_input";
  controls: Control[];
  viewer: number;
  detach: boolean;
}
export const version = 1;
export const viewer_version = 3;
export type Op = (typeof operations)[number];
export type Command = Record<string, Record<string, any>>;
export type Result = { pane: number; tab: number; workspace: number; text: string | null; closed_panes: number[] };
export const emptyResult = (): Result => ({ pane: 0, tab: 0, workspace: 0, text: null, closed_panes: [] });
export const operations = [
  "hello",
  "session.command",
  "session.locate",
  "session.list",
  "session.snapshot",
  "session.subscribe",
  "viewer.watch",
  "agent.subscribe",
  "viewer.open",
  "viewer.sync",
  "viewer.search",
  "pane.acknowledge",
  "pane.paste",
  "conversation.list",
  "conversation.acknowledge",
  "pane.surface",
  "server.reload",
  "recovery.save",
  "inference.configure",
  "shell.configure",
  "smart_links.configure",
  "git.push",
  "onboarding.status",
  "onboarding.handoff",
  "onboarding.copy",
  "agent.command.preview",
  "agent.preview",
  "agent.track_usage",
  "agent.history",
  "viewer.list",
  "action",
  "focus",
  "workspace.switch",
  "native.start",
  "native.list",
  "native.stop",
  "native.send",
  "native.events",
  "theme",
  "hook",
  "ping",
  "shutdown",
  "test.settle",
  "test.advance",
] as const;
const local = new Set([
  "viewer.list",
  "action",
  "focus",
  "workspace.switch",
  "native.start",
  "native.list",
  "native.stop",
  "native.send",
  "native.events",
  "theme",
  "hook",
  "ping",
  "shutdown",
  "test.settle",
  "test.advance",
]);
export function check(op: string): "none" | "negotiate" | "runtime" | "viewer" {
  if (op === "hello") return "negotiate";
  if (op === "viewer.open" || op === "viewer.sync") return "viewer";
  return local.has(op) ? "none" : "runtime";
}
export const capabilities = operations.filter(op => check(op) === "runtime" || check(op) === "viewer");
export function envelope(op: string, payload: Record<string, unknown> = {}): object {
  const fields = op === "viewer.open" ? { cwd: "", onboarding: false, theme: null, ...payload } : payload;
  return {
    op,
    ...(check(op) !== "none" ? { protocol: version } : {}),
    ...(check(op) === "viewer" ? { viewer_protocol: viewer_version } : {}),
    ...Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== null || key === "theme")),
  };
}
export function parse(value: any): Op | null {
  return operations.includes(value?.op) ? value.op : null;
}
export function require(value: any, negotiated: number | null): void {
  if (!Object.hasOwn(value, "protocol") && negotiated === null) throw Error("ProtocolRequired");
  if ((Object.hasOwn(value, "protocol") ? value.protocol : negotiated) !== version) throw Error("UnsupportedProtocol");
}
export function id(value: any, field: string): number {
  if (!Object.hasOwn(value, field)) throw Error("MissingField");
  const n = value[field];
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw Error("InvalidId");
  return n;
}
export function exclusion(op: string): "none" | "layout" | "import" | "push" | "reload" | "shutdown" {
  if (op === "session.command") return "layout";
  if (op === "onboarding.handoff" || op === "onboarding.copy") return "import";
  if (op === "git.push") return "push";
  if (op === "server.reload") return "reload";
  if (op === "shutdown") return "shutdown";
  return "none";
}
// Required fields are suffixed with !; closed command payloads reject unknown fields.
const commands: Record<string, string> = {
  "agent.move": "workspace! target! before",
  "agent.command": "index! command! hidden name original semantics resolve cwd",
  "agent.command.create": "workspace! cwd index!",
  "agent.visibility": "hidden!",
  "agent.yolo": "provider! enabled!",
  "agent.create": "workspace! cwd provider",
  "agent.resume": "workspace! cwd! provider! session! asleep name",
  "agent.rename": "target! name",
  "agent.fork": "target! name check",
  "pane.create": "workspace! from cwd command title",
  "pane.split": "target! direction cwd command title",
  "pane.close": "target!",
  "tab.close": "target!",
  "pane.restore": "workspace!",
  "pane.wake": "target! shell",
  "workspace.create": "name cwd!",
  "workspace.edit": "target! name cwd",
  "workspace.close": "target! close_contents",
  "workspace.move": "target! before!",
  "pane.rename": "target! name!",
  "tab.rename": "target! name!",
  "pane.swap": "target! other!",
  "pane.resize": "target! axis! ratio!",
  "split.resize": "target! direction!",
  "split.ratio": "target! other! ratio! expected!",
  "pane.move": "target! destination!",
  "tab.move": "target! destination!",
  "tab.merge": "target! other! direction",
  "pane.read": "target! lines view",
  "pane.send": "target! text! enter",
  "pane.keys": "target! text!",
  "pane.input": "target! data!",
};
const defaults: Record<string, Record<string, unknown>> = {
  "agent.command": { hidden: false, name: null, original: null, semantics: null, resolve: true, cwd: null },
  "agent.command.create": { cwd: "" },
  "agent.create": { cwd: "", provider: null },
  "agent.resume": { asleep: false, name: "" },
  "agent.rename": { name: null },
  "agent.fork": { name: null, check: false },
  "pane.create": { from: null, cwd: "", command: null, title: "" },
  "pane.split": { direction: "right", cwd: "", command: null, title: "" },
  "workspace.create": { name: "" },
  "workspace.edit": { name: null, cwd: null },
  "workspace.close": { close_contents: false },
  "tab.merge": { direction: "right" },
  "pane.read": { lines: 100, view: "history" },
  "pane.send": { enter: false },
  "pane.wake": { shell: false },
  "agent.move": { before: null },
};
export function decodeCommand(value: unknown): Command {
  const v = object(value),
    names = Object.keys(v);
  if (names.length !== 1) throw Error("UnexpectedToken");
  const name = names[0],
    spec = commands[name];
  if (!spec) throw Error("UnknownField");
  const payload = object(v[name]),
    fields = spec.split(" ");
  for (const field of fields)
    if (field.endsWith("!") && !Object.hasOwn(payload, field.slice(0, -1))) throw Error("MissingField");
  const known = fields.map(f => f.replace(/!$/, ""));
  for (const field of Object.keys(payload)) if (!known.includes(field)) throw Error("UnknownField");
  for (const [field, item] of Object.entries(payload)) {
    if (name === "agent.move" && (field === "target" || field === "before")) {
      if (item === null && field === "before") continue;
      target(item);
      continue;
    }
    if (["target", "other", "workspace", "from", "before"].includes(field))
      validate(item, field === "from" ? "?u32" : "u32");
    if (["name", "cwd", "command", "original", "text", "data", "title", "session"].includes(field))
      validate(item, defaults[name]?.[field] === null ? "?string" : "string");
    if (
      ["check", "resolve", "close_contents", "enter", "enabled", "shell", "asleep"].includes(field) ||
      (field === "hidden" && name !== "agent.visibility")
    )
      validate(item, "bool");
    if (["index", "lines", "expected"].includes(field)) validate(item, "u64");
    if (field === "ratio") validate(item, "u16");
    if (field === "view") validate(item, "history|screen");
  }
  if (name === "agent.visibility")
    payload.hidden = struct(payload.hidden, { codex: ["bool", false], claude: ["bool", false] }, true);
  if (name === "agent.command" && payload.semantics !== undefined && payload.semantics !== null)
    payload.semantics = struct(
      payload.semantics,
      {
        provider: ["?codex|claude", null],
        suggested_name: ["string", ""],
        model: ["string", ""],
        model_name: ["string", ""],
        account: ["string", ""],
        mode: ["string", ""],
        yolo: ["bool", false],
        default_account: ["bool", false],
      },
      true,
    );
  if (payload.direction !== undefined && !["left", "right", "up", "down"].includes(payload.direction))
    throw Error("InvalidEnumTag");
  if (payload.axis !== undefined && !["horizontal", "vertical"].includes(payload.axis)) throw Error("InvalidEnumTag");
  if (payload.provider !== undefined && payload.provider !== null && !["codex", "claude"].includes(payload.provider))
    throw Error("InvalidEnumTag");
  if (name === "pane.move" || name === "tab.move") {
    const destination = object(payload.destination),
      tags = Object.keys(destination);
    if (tags.length !== 1) throw Error("UnexpectedToken");
    const allowed = name === "pane.move" ? ["new_tab", "beside"] : ["workspace", "before", "after"];
    if (!allowed.includes(tags[0])) throw Error("UnknownField");
    const value = destination[tags[0]];
    if (tags[0] === "new_tab") {
      if (typeof value !== "string") throw Error("UnexpectedToken");
    } else if (tags[0] === "beside") {
      object(value);
      if (!Object.hasOwn(value, "other")) throw Error("MissingField");
      validate(value.other, "u32");
      if (Object.keys(value).some(k => !["other", "direction"].includes(k))) throw Error("UnknownField");
      if (value.direction !== undefined && !["left", "right", "up", "down"].includes(value.direction))
        throw Error("InvalidEnumTag");
      value.direction ??= "right";
    } else if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw Error("UnexpectedToken");
  }
  return { [name]: { ...defaults[name], ...payload } };
}
export function decode(op: Op, value: any): any {
  object(value);
  if (op === "session.command") {
    if (!Object.hasOwn(value, "command")) throw Error("MissingField");
    return { command: decodeCommand(value.command) };
  }
  const spec = requests[op];
  return spec ? struct(value, spec, false) : {};
}
export const stamp_bucket = 5_000_000;
type Field = string | readonly [string, unknown];
type Fields = Record<string, Field>;
function target(value: unknown) {
  const t = object(value),
    keys = Object.keys(t);
  if (keys.length !== 1) throw Error("UnexpectedToken");
  if (!["pane", "native"].includes(keys[0])) throw Error("UnknownField");
  validate(t[keys[0]], "u32");
  return t;
}
function validate(value: any, type: string): any {
  if (type[0] === "?") {
    if (value === null) return null;
    return validate(value, type.slice(1));
  }
  if (type.startsWith("[]")) {
    if (!Array.isArray(value)) throw Error("UnexpectedToken");
    return value.map(v => validate(v, type.slice(2)));
  }
  if (type === "json") return value;
  if (type === "theme") {
    try {
      return Object.assign(
        new Theme(),
        struct(
          value,
          { foreground: ["?rgb", null], background: ["?rgb", null], palette: ["[]?rgb", Array(16).fill(null)] },
          false,
        ),
      );
    } catch {
      return null;
    }
  }
  if (type === "string" || type === "bool") {
    if (typeof value !== (type === "string" ? "string" : "boolean")) throw Error("UnexpectedToken");
    return value;
  }
  if (/^[ui](8|16|32|64)$/.test(type)) {
    if (typeof value !== "bigint" && !Number.isInteger(value)) throw Error("UnexpectedToken");
    const n = BigInt(value),
      bits = BigInt(type.slice(1)),
      signed = type[0] === "i",
      min = signed ? -(1n << (bits - 1n)) : 0n,
      max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    if (n < min || n > max) throw Error("Overflow");
    return bits < 64n ? Number(n) : value;
  }
  if (type.includes("|")) {
    if (typeof value !== "string") throw Error("UnexpectedToken");
    if (!type.split("|").includes(value)) throw Error("InvalidEnumTag");
    return value;
  }
  const nested = structures[type];
  if (nested) return struct(value, nested, false);
  throw Error("InvalidProtocolSchema");
}
function struct(value: any, fields: Fields, strict: boolean) {
  const source = object(value),
    out: Record<string, any> = {};
  if (strict) for (const key of Object.keys(source)) if (!Object.hasOwn(fields, key)) throw Error("UnknownField");
  for (const [key, field] of Object.entries(fields)) {
    const [type, defaultValue] = typeof field === "string" ? [field, undefined] : field;
    if (!Object.hasOwn(source, key)) {
      if (typeof field === "string") throw Error("MissingField");
      out[key] = structuredClone(defaultValue);
      continue;
    }
    out[key] = validate(source[key], type);
  }
  if (fields === structures.rgb) return out;
  if (Object.hasOwn(out, "palette") && out.palette.length !== 16) throw Error("UnexpectedToken");
  return out;
}
const structures: Record<string, Fields> = {
  rgb: { r: "u8", g: "u8", b: "u8" },
  stamp: { identity: "u64", revision: "u64", offset: "?u64" },
  interest: { pane: "u32", cols: "u16", rows: "u16", offset: ["?u64", null], known: ["?stamp", null] },
  image: { mime: "string", path: "string" },
  ref: {
    root: ["string", ""],
    head: ["string", ""],
    branch: ["string", ""],
    remote: ["string", ""],
    destination: ["string", ""],
  },
  importPane: {
    id: "string",
    name: "string",
    cwd: ["string", ""],
    pid: ["?i32", null],
    url: ["string", ""],
    x: ["u16", 0],
    y: ["u16", 0],
    w: ["u16", 80],
    h: ["u16", 24],
    resume_available: ["bool", false],
    history: ["string", ""],
    screen: ["string", ""],
    restart_command: ["string", ""],
  },
  importTab: { id: "string", name: "string", panes: "[]importPane", nodes: ["[]json", []] },
  importWorkspace: {
    id: "string",
    name: "string",
    cwd: ["string", ""],
    socket: ["string", ""],
    session: ["u64", 0],
    activity: ["i64", 0],
    handoff: ["bool", false],
    recovery: ["full|layout|partial|workspace", "full"],
    recovery_note: ["string", ""],
    tabs: "[]importTab",
  },
};
const launch: Fields = { workspace: "u32", cwd: ["string", ""] };
const requests: Partial<Record<Op, Fields>> = {
  "session.locate": { pane: "u32" },
  "viewer.watch": { viewer: "u32" },
  "agent.subscribe": launch,
  "agent.preview": launch,
  "agent.track_usage": launch,
  "viewer.open": { cwd: ["string", ""], onboarding: ["bool", false], theme: ["theme", null] },
  "viewer.sync": {
    interests: "[]interest",
    session_hash: ["?u64", null],
    focus: ["?u32", null],
    watched: ["bool", true],
    workspace: ["u32", 0],
    ack: ["u64", 0],
    active: ["bool", false],
    resource_detail: ["?u32", null],
    worktree_detail: ["?u32", null],
    resources: ["bool", true],
    resources_hash: ["?u64", null],
  },
  "viewer.search": { pane: "u32", needle: "string", skip: ["u64", 0] },
  "pane.paste": { pane: "u32", text: ["?string", null], image: ["?image", null] },
  "pane.acknowledge": {
    pane: "u32",
    session: ["string", ""],
    through: ["u64", 0],
    binding: ["?u64", null],
    conversation: ["?u32", null],
    attention_at: ["?i64", null],
  },
  "conversation.acknowledge": { conversation: "u32", through: "u64", attention_at: ["?i64", null] },
  "pane.surface": { pane: "u32" },
  "server.reload": { executable: ["string", ""] },
  "inference.configure": { choice: "auto|codex|claude|off" },
  "shell.configure": { shell: "string" },
  "smart_links.configure": { enabled: "bool" },
  "git.push": { workspace: "u32", ref: "ref" },
  "onboarding.status": { operation: "u64" },
  "onboarding.handoff": { operation: "u64", viewer_pgid: "i32", socket: ["string", ""] },
  "onboarding.copy": {
    operation: "u64",
    source: "tmux|herdr|cmux",
    workspaces: "[]importWorkspace",
    herdr_session: ["?json", null],
    selected: ["[]string", []],
  },
  "agent.command.preview": { workspace: "u32", cwd: ["string", ""], request: "u64", command: ["string", ""] },
  "agent.history": { follow: ["bool", false] },
  action: { name: ["string", ""], value: ["string", ""], viewer: ["?u32", null], pane: ["?u32", null] },
  focus: { pane: "u32", viewer: ["?u32", null] },
  "workspace.switch": { workspace: "u32", viewer: ["?u32", null] },
  "native.start": { provider: "codex|claude", cwd: ["string", ""], workspace: ["?u32", null] },
  "native.stop": { session: "u32" },
  "native.send": { session: "u32", message: "json" },
  "native.events": { session: "u32", after: ["u64", 0] },
  theme: { theme: ["theme", null] },
  hook: {
    provider: "codex|claude",
    event: "json",
    pane: ["u32", 0],
    seq: ["?i64", null],
    background: ["bool", false],
    pid: ["i32", 0],
  },
  "test.advance": { ms: "i64" },
};
const rejections = new Set([
  "StaleLayout",
  "NoPane",
  "AmbiguousViewer",
  "NoViewer",
  "UnsupportedViewerProtocol",
  "UnsupportedProtocol",
  "ProtocolRequired",
  "GitPreviewChanged",
  "GitPushInProgress",
  "ReloadInProgress",
  "NoWorkspace",
  "NothingToPush",
  "TooManyPushes",
  "AgentBusy",
  "RenameUnavailable",
  "NoConversation",
  "InvalidName",
  "ShellNotFound",
]);
export function rejection(name: string): string {
  return rejections.has(name) ? name : "ServerRejected";
}
