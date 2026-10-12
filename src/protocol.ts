import * as json from "./json";
import { Theme } from "./theme";
import type { View as SurfaceView } from "./pane/surface";
import type { Provider } from "./providers";
import type { Target } from "./agent_order";
export interface Control {
  seq: bigint;
  kind: "focus" | "workspace" | "action";
  id?: number;
  name?: string;
  value?: string;
}
export interface Opened {
  viewer_protocol: number;
  bell_seq: bigint;
  workspace: number;
}
export interface View<Session = unknown, Resources = unknown> {
  type: "view";
  viewer_protocol: number;
  session: Session | null;
  session_hash: bigint;
  resources: Resources | null;
  resources_hash: bigint;
  surfaces: SurfaceView[];
  bell_seq: bigint;
  bell_kind: "none" | "finished" | "needs_input";
  controls: Control[];
  viewer: number;
  detach: boolean;
}
export const version = 1;
export const viewer_version = 3;
export type Op = (typeof operations)[number];
type PaneDestination = { new_tab: string } | { beside: Normalized<typeof structures.beside> };
type TabDestination = { workspace: number } | { before: number } | { after: number };
export type CommandName = keyof typeof commands;
export type CommandPayloads = { [K in CommandName]: Normalized<(typeof commands)[K]> };
export type Command = { [K in CommandName]: { [P in K]: CommandPayloads[K] } }[CommandName];
export type CommandInputs = { [K in CommandName]: Input<(typeof commands)[K]> };
export type CommandInput = { [K in CommandName]: { [P in K]: CommandInputs[K] } }[CommandName];
export type DecodedCommand = { [K in CommandName]: { op: K; payload: CommandPayloads[K] } }[CommandName];
export function command(value: Command): DecodedCommand {
  const op = Object.keys(value)[0] as CommandName;
  return { op, payload: (value as Record<string, unknown>)[op] } as DecodedCommand;
}
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
  "pane.mark_unread",
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
  "worktree.remove",
  "worktree.stop",
  "worktree.brief",
  "worktree.add",
  "git.branches",
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
export function parse(value: unknown): Op | null {
  if (value === null || typeof value !== "object") return null;
  const op = (value as Record<string, unknown>).op;
  return typeof op === "string" && (operations as readonly string[]).includes(op) ? (op as Op) : null;
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
const commands = {
  "agent.move": { workspace: "u32", target: "target", before: ["?target", null] },
  "agent.command": {
    index: "u64",
    command: "string",
    hidden: ["bool", false],
    name: ["?string", null],
    original: ["?string", null],
    semantics: ["?semantics", null],
    resolve: ["bool", true],
    cwd: ["?string", null],
  },
  "agent.command.create": { workspace: "u32", cwd: ["string", ""], index: "u64" },
  "agent.visibility": { hidden: "visibility" },
  "agent.yolo": { provider: "codex|claude", enabled: "bool" },
  "agent.create": { workspace: "u32", cwd: ["string", ""], provider: ["?codex|claude", null] },
  "agent.resume": {
    workspace: "u32",
    cwd: "string",
    provider: "codex|claude",
    session: "string",
    asleep: ["bool", false],
    name: ["string", ""],
  },
  "agent.rename": { target: "u32", name: ["?string", null] },
  "agent.fork": { target: "u32", name: ["?string", null], check: ["bool", false] },
  "pane.create": {
    workspace: "u32",
    from: ["?u32", null],
    cwd: ["string", ""],
    command: ["?string", null],
    title: ["string", ""],
  },
  "pane.split": {
    target: "u32",
    direction: ["left|right|up|down", "right"],
    cwd: ["string", ""],
    command: ["?string", null],
    title: ["string", ""],
  },
  "pane.close": { target: "u32" },
  "tab.close": { target: "u32" },
  "pane.restore": { workspace: "u32" },
  "pane.wake": { target: "u32", shell: ["bool", false] },
  "workspace.create": { name: ["string", ""], cwd: "string" },
  "workspace.edit": { target: "u32", name: ["?string", null], cwd: ["?string", null] },
  "workspace.close": { target: "u32", close_contents: ["bool", false] },
  "workspace.move": { target: "u32", before: "u32" },
  "pane.rename": { target: "u32", name: "string" },
  "tab.rename": { target: "u32", name: "string" },
  "pane.swap": { target: "u32", other: "u32" },
  "pane.resize": { target: "u32", axis: "horizontal|vertical", ratio: "u16" },
  "split.resize": { target: "u32", direction: "left|right|up|down" },
  "split.ratio": { target: "u32", other: "u32", ratio: "u16", expected: "u64" },
  "pane.move": { target: "u32", destination: "paneDestination" },
  "tab.move": { target: "u32", destination: "tabDestination" },
  "tab.merge": { target: "u32", other: "u32", direction: ["left|right|up|down", "right"] },
  "pane.read": { lines: ["u64", 100n], view: ["history|screen", "history"], target: "u32" },
  "pane.send": { target: "u32", text: "string", enter: ["bool", false] },
  "pane.keys": { target: "u32", text: "string" },
  "pane.input": { target: "u32", data: "string" },
} as const satisfies Record<string, Fields>;
export function decodeCommand(value: unknown): Command {
  const source = json.object(value),
    names = Object.keys(source);
  if (names.length !== 1) throw Error("UnexpectedToken");
  const name = names[0];
  if (!Object.hasOwn(commands, name)) throw Error("UnknownField");
  return { [name]: struct(source[name], commands[name as CommandName], true) } as Command;
}
export function decode<K extends Op>(op: K, input: unknown): Requests[K] {
  const value = json.object(input);
  if (op === "session.command") {
    if (!Object.hasOwn(value, "command")) throw Error("MissingField");
    return { command: decodeCommand(value.command) } as Requests[K];
  }
  const spec = (requests as Partial<Record<Op, Fields>>)[op];
  return (spec ? struct(value, spec, false) : {}) as Requests[K];
}
type Alternatives<T extends string> = T extends `${infer Head}|${infer Tail}` ? Head | Alternatives<Tail> : T;
type TaggedValues = { target: Target; paneDestination: PaneDestination; tabDestination: TabDestination };
type Value<T extends string> = T extends `?${infer Inner}`
  ? Value<Inner> | null
  : T extends `[]${infer Inner}`
    ? Value<Inner>[]
    : T extends "string"
      ? string
      : T extends "bool"
        ? boolean
        : T extends "u64" | "i64"
          ? bigint
          : T extends `u${number}` | `i${number}`
            ? number
            : T extends "json"
              ? unknown
              : T extends "theme"
                ? Theme | null
                : T extends keyof TaggedValues
                  ? TaggedValues[T]
                  : T extends keyof typeof structures
                    ? Normalized<(typeof structures)[T]>
                    : Alternatives<T>;
type FieldValue<F extends Field> = Value<F extends string ? F : F[0]>;
type Normalized<S extends Fields> = { -readonly [K in keyof S]: FieldValue<S[K]> };
type InputValue<T extends string> = T extends `?${infer Inner}`
  ? InputValue<Inner> | null
  : T extends `[]${infer Inner}`
    ? InputValue<Inner>[]
    : T extends "u64" | "i64"
      ? number | bigint
      : T extends "theme"
        ? Partial<Pick<Theme, "foreground" | "background" | "palette">> | null
        : T extends "paneDestination"
          ? { new_tab: string } | { beside: Input<typeof structures.beside> }
          : T extends keyof typeof structures
            ? Input<(typeof structures)[T]>
            : Value<T>;
type InputField<F extends Field> = InputValue<F extends string ? F : F[0]>;
type Input<S extends Fields> = {
  -readonly [K in keyof S as S[K] extends string ? K : never]: InputField<S[K]>;
} & {
  -readonly [K in keyof S as S[K] extends string ? never : K]?: InputField<S[K]>;
};
export type Requests = {
  [K in Op]: K extends "session.command"
    ? { command: Command }
    : K extends keyof typeof requests
      ? Normalized<(typeof requests)[K]>
      : Record<string, never>;
};
export type RequestInputs = {
  [K in Op]: K extends "session.command"
    ? { command: CommandInput }
    : K extends keyof typeof requests
      ? Input<(typeof requests)[K]>
      : Record<string, never>;
};
export type Request<K extends Op> = Requests[K];
export type RequestInput<K extends Op> = RequestInputs[K];
export type DecodedRequest = { [K in Op]: { op: K; payload: Requests[K] } }[Op];
export function decoded(op: Op, value: unknown): DecodedRequest {
  return { op, payload: decode(op, value) } as DecodedRequest;
}
export const stamp_bucket = 5_000_000;
type Field = string | readonly [string, unknown];
type Fields = Record<string, Field>;
function target(value: unknown) {
  const t = json.object(value),
    keys = Object.keys(t);
  if (keys.length !== 1) throw Error("UnexpectedToken");
  if (!["pane", "native"].includes(keys[0])) throw Error("UnknownField");
  return { [keys[0]]: validate(t[keys[0]], "u32") };
}
function destination(value: unknown, pane: boolean) {
  const source = json.object(value),
    tags = Object.keys(source);
  if (tags.length !== 1) throw Error("UnexpectedToken");
  const tag = tags[0];
  switch (tag) {
    case "new_tab":
      if (pane) return { new_tab: validate(source[tag], "string") };
      break;
    case "beside":
      if (pane) return { beside: struct(source[tag], structures.beside, true) };
      break;
    case "workspace":
    case "before":
    case "after":
      if (!pane) return { [tag]: validate(source[tag], "u32") };
      break;
  }
  throw Error("UnknownField");
}
function validate(value: any, type: string, strict = false): any {
  if (type[0] === "?") {
    if (value === null) return null;
    return validate(value, type.slice(1), strict);
  }
  if (type.startsWith("[]")) {
    if (!Array.isArray(value)) throw Error("UnexpectedToken");
    return value.map(v => validate(v, type.slice(2), strict));
  }
  if (type === "json") return value;
  if (type === "target") return target(value);
  if (type === "paneDestination" || type === "tabDestination") return destination(value, type === "paneDestination");
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
    if (typeof value !== "bigint") {
      if (typeof value !== "number" || !Number.isInteger(value)) throw Error("UnexpectedToken");
      if (!Number.isSafeInteger(value)) throw Error("Overflow");
    }
    const n = BigInt(value),
      bits = BigInt(type.slice(1)),
      signed = type[0] === "i",
      min = signed ? -(1n << (bits - 1n)) : 0n,
      max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    if (n < min || n > max) throw Error("Overflow");
    return bits < 64n ? Number(n) : n;
  }
  if (type.includes("|")) {
    if (typeof value !== "string") throw Error("UnexpectedToken");
    if (!type.split("|").includes(value)) throw Error("InvalidEnumTag");
    return value;
  }
  const nested = (structures as Record<string, Fields>)[type];
  if (nested) return struct(value, nested, strict);
  throw Error("InvalidProtocolSchema");
}
function struct(value: any, fields: Fields, strict: boolean) {
  const source = json.object(value),
    out: Record<string, any> = {};
  if (strict) for (const key of Object.keys(source)) if (!Object.hasOwn(fields, key)) throw Error("UnknownField");
  for (const [key, field] of Object.entries(fields)) {
    const [type, defaultValue] = typeof field === "string" ? [field, undefined] : field;
    if (!Object.hasOwn(source, key)) {
      if (typeof field === "string") throw Error("MissingField");
      out[key] = validate(structuredClone(defaultValue), type, strict);
      continue;
    }
    out[key] = validate(source[key], type, strict);
  }
  if (fields === structures.rgb) return out;
  if (Object.hasOwn(out, "palette") && out.palette.length !== 16) throw Error("UnexpectedToken");
  return out;
}
const structures = {
  visibility: { codex: ["bool", false], claude: ["bool", false] },
  semantics: {
    provider: ["?codex|claude", null],
    suggested_name: ["string", ""],
    model: ["string", ""],
    model_name: ["string", ""],
    account: ["string", ""],
    mode: ["string", ""],
    yolo: ["bool", false],
    default_account: ["bool", false],
  },
  beside: { other: "u32", direction: ["left|right|up|down", "right"] },
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
} as const satisfies Record<string, Fields>;
const launch = { workspace: "u32", cwd: ["string", ""] } as const satisfies Fields;
const requests = {
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
  "pane.mark_unread": {
    pane: "u32",
    session: ["string", ""],
    binding: ["?u64", null],
    conversation: ["?u32", null],
  },
  "conversation.acknowledge": { conversation: "u32", through: "u64", attention_at: ["?i64", null] },
  "pane.surface": { pane: "u32" },
  "server.reload": { executable: ["string", ""] },
  "inference.configure": {
    choice: ["?auto|codex|claude|off", null],
    activity: ["?bool", null],
    worktrees: ["?bool", null],
  },
  "shell.configure": { shell: "string" },
  "smart_links.configure": { enabled: "bool" },
  "git.push": { workspace: "u32", ref: "ref" },
  "worktree.remove": { workspace: "u32", path: "string" },
  "worktree.stop": { workspace: "u32" },
  "worktree.brief": { workspace: "u32" },
  "worktree.add": { workspace: "u32", path: "string", branch: "string", base: "string" },
  "git.branches": { workspace: "u32" },
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
} as const satisfies Partial<Record<Op, Fields>>;
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
  "NoWorktree",
  "WorktreeLocked",
  "WorktreeInUse",
  "WorktreeRemoveFailed",
  "WorktreeRemoving",
  "WorktreeAddFailed",
  "BranchExists",
  "FolderExists",
  "InvalidBranch",
  "BranchesUnavailable",
  "AgentBusy",
  "RenameUnavailable",
  "NoConversation",
  "InvalidName",
  "ShellNotFound",
]);
export function rejection(name: string): string {
  return rejections.has(name) ? name : "ServerRejected";
}
/** JSON replies contain values and serialized fields, never class methods. */
export type Wire<T> = unknown extends T ? T : T extends { toJSON(): infer Value } ? WireFields<Value> : WireFields<T>;
type WireFields<T> = unknown extends T
  ? T
  : T extends bigint
    ? number | bigint
    : T extends readonly unknown[]
      ? { [K in keyof T]: Wire<T[K]> }
      : T extends object
        ? { [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: Wire<T[K]> }
        : T;

// RPC success payloads; opaque provider messages remain unknown.
type SessionSnapshot = ReturnType<typeof import("./session").snapshot>;
type ViewerSnapshot = ReturnType<typeof import("./session").viewerSnapshot>;
type Ok = { ok: true };
type ViewerInfo = { id: number; workspace: number; pane: number | null; watched: boolean };
export interface ReplyPayloads {
  hello: {
    type: "hello";
    protocol: number;
    capabilities: Op[];
    server_pid: number;
    build_id: string;
    executable: string;
    release_version: string;
    update_abi: string;
  };
  ping: Ok & { pid: number };
  "session.command": Ok & { result: Result };
  "session.locate": Ok & { result: Result };
  "session.list": Ok & { result: SessionSnapshot; viewers: ViewerInfo[] };
  "session.snapshot": SessionSnapshot;
  "session.subscribe": SessionSnapshot;
  "viewer.open": Ok & Opened;
  "viewer.sync": View<ViewerSnapshot, import("./trackers/resources").Snapshot>;
  "viewer.search": Ok & {
    offset: bigint | null;
    match?: { x: number; y: number; end_x: number; end_y: number } | null;
  };
  "viewer.list": Ok & { viewers: ViewerInfo[] };
  "pane.paste": Ok & { pasted: boolean };
  "pane.surface": {
    type: "surface";
    protocol: number;
    server_pid: number;
    revision: bigint;
    surface: SurfaceView["surface"];
  };
  "conversation.list": Ok & { conversations: SessionSnapshot["conversations"] };
  "recovery.save": Ok & { path: string };
  "inference.configure": Ok & { saved: boolean; inference: import("./corgi_setup").Status };
  "shell.configure": Ok & { shell: import("./launch/command").ShellStatus };
  "smart_links.configure": Ok & { smart_links: boolean };
  "worktree.remove": Ok & { removal: number };
  "git.branches": Ok & { branches: Awaited<ReturnType<typeof import("./worktree_add").branches>> };
  "onboarding.status": Ok & {
    progress: import("./import/onboarding").Progress | ReturnType<import("./import/herdr").Manager["status"]>;
  };
  "agent.command.preview": Ok & { resolution: import("./launch/command").Resolution };
  "agent.preview": Ok & { preview: import("./launch/preview").Preview };
  "agent.track_usage": Ok & { preview: import("./launch/preview").Preview };
  "agent.subscribe": { type: "agent.preview"; cwd: string; preview: import("./launch/preview").Preview };
  "agent.history": Ok & { history: import("./launch/history").History };
  action: Ok & { viewer: number; queued: true };
  focus: Ok & { viewer: number; queued: true };
  "workspace.switch": Ok & { viewer: number; queued: true };
  "native.start": Ok & { session: number; provider: Provider };
  "native.list": Ok & { sessions: unknown[] };
  "native.events": Ok & {
    events: unknown[];
    pending_requests: unknown;
    next_seq: bigint;
    first_seq: bigint;
  };
}
// RPC returns raw JSON: small integer tokens are numbers until a consumer
// normalizes its model. WireReply never claims to contain bigint-only fields.
export type WireReply<K extends Op> = K extends keyof ReplyPayloads ? Wire<ReplyPayloads[K]> : Ok;
export type Reply<K extends Op> = WireReply<K>;
export type ErrorReply = { err: string; viewer_protocol?: number };
export type Response<K extends Op> = Reply<K> | ErrorReply;
export type Arguments<K extends Op> =
  {} extends RequestInput<K> ? [fields?: RequestInput<K>] : [fields: RequestInput<K>];
