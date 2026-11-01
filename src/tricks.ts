import * as palette from "./palette";
import { Provider } from "./providers";
import type { State, Attention } from "./agents";
import * as process_name from "./process_name";

export const version = 1;
export const max_bytes = 65536;
export const max_views = 256;
export type Color =
  | palette.Token
  | `#${string}`
  | { brand: process_name.Brand }
  | { syntax: palette.Syntax }
  | { mix: [Color, Color]; amount: number };
export interface Agent {
  id: string;
  provider: Provider;
  account: string;
  workspace: number;
  session: string;
  name: string;
  state: State;
  attention: Attention;
  activity: string;
  completed: string;
}
export type Selector = Partial<Pick<Agent, "id" | "provider" | "account" | "workspace" | "session" | "state">>;
export interface Snapshot {
  agents: Agent[];
  workspaces: { id: number; name: string; cwd: string }[];
}
export const metadata_events = ["snapshot", "agent.changed", "agent.removed", "hook"] as const;
export const events = [...metadata_events, "transcript"] as const;
export type EventName = (typeof events)[number];
export type EventPattern = EventName | "metadata:*";
export type Event =
  | ({ event: "snapshot" } & Snapshot)
  | { event: "agent.changed"; agent: Agent; previous: Agent | null }
  | { event: "agent.removed"; agent: Agent }
  | { event: "hook"; agent: Agent | null; provider: Provider; kind: string; tool: string }
  | { event: "transcript"; agent: Agent; record: unknown; truncated: boolean };
export interface Subscription {
  events: EventName[];
  where: Selector;
}
export interface Span {
  text: string;
  color?: Color;
  icon?: process_name.Brand;
  bold?: boolean;
  italic?: boolean;
}
export const max_nodes = 128;
export const max_depth = 8;
export type Element =
  | { kind: "text"; spans: Span[] }
  | { kind: "button"; spans: Span[]; action: string; slot?: string }
  | { kind: "row"; children: Element[] }
  | { kind: "column"; children: Element[] };
export const surfaces = ["sidebar", "popover", "pane"] as const;
export type Surface = (typeof surfaces)[number];
export type UiEvent = `ui:agent.${Surface}`;
export function surface(event: unknown): Surface | null {
  return surfaces.find(name => event === `ui:agent.${name}`) ?? null;
}
export interface Decoration {
  kind: "decorate";
  surface?: Surface;
  where: Selector;
  color?: Color;
  marker?: Color;
  suffix: Span[];
  content?: Element;
}
export interface Overlay {
  kind: "overlay";
  anchor: "top-right" | "bottom-right" | "top-left" | "bottom-left";
  lines: Span[][];
  content?: Element;
}
export type View = Decoration | Overlay;
export type Command =
  | { op: "ui.set"; key: string; view: View }
  | { op: "ui.remove"; key: string }
  | { op: "subscribe"; subscription: Subscription }
  | { op: "ui.focus"; viewer: number; agent: string }
  | { op: "kv.get" | "kv.delete"; key: string }
  | { op: "kv.set"; key: string; value: unknown };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("ExpectedObject");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw Error("UnknownField");
}
function string(value: unknown, limit = 1024): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > limit) throw Error("InvalidString");
  return value;
}
export function key(value: unknown): string {
  return reference(string(value, 80));
}
export function reference(value: unknown): string {
  const result = string(value, 160);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result)) throw Error("InvalidKey");
  return result;
}
export function selector(value: unknown = {}): Selector {
  const source = object(value),
    out: Selector = {};
  fields(source, ["id", "provider", "account", "workspace", "session", "state"]);
  for (const name of ["id", "account", "session"] as const)
    if (source[name] !== undefined) out[name] = string(source[name]);
  if (source.provider !== undefined) {
    const provider = Provider.parse(string(source.provider));
    if (!provider) throw Error("InvalidProvider");
    out.provider = provider;
  }
  if (source.workspace !== undefined) {
    if (!Number.isSafeInteger(source.workspace) || Number(source.workspace) < 1) throw Error("InvalidWorkspace");
    out.workspace = Number(source.workspace);
  }
  const state = source.state;
  if (state !== undefined) {
    switch (state) {
      case "unknown":
      case "initializing":
      case "idle":
      case "working":
      case "blocked":
      case "done":
        out.state = state as State;
        break;
      default:
        throw Error("InvalidState");
    }
  }
  return out;
}
export function matches(where: Selector, agent: Partial<Omit<Agent, "state">> & { state?: string }): boolean {
  return Object.entries(where).every(([k, v]) => agent[k as keyof Agent] === v);
}
export function subscription(value: unknown): Subscription {
  const source = object(value);
  fields(source, ["events", "where"]);
  const names = typeof source.events === "string" ? [source.events] : source.events;
  if (!Array.isArray(names) || names.some(e => e !== "metadata:*" && !events.includes(e))) throw Error("InvalidEvents");
  return {
    events: [...new Set(names.flatMap(e => (e === "metadata:*" ? metadata_events : [e])))] as EventName[],
    where: selector(source.where),
  };
}
export function color(value: unknown, depth = 0): Color | undefined {
  if (value === undefined) return undefined;
  if (depth > 4) throw Error("ColorTooDeep");
  if (value && typeof value === "object") {
    const source = object(value);
    if (source.syntax !== undefined) {
      fields(source, ["syntax"]);
      if (typeof source.syntax !== "string" || !Object.hasOwn(palette.syntax, source.syntax))
        throw Error("InvalidSyntaxColor");
      return { syntax: source.syntax as palette.Syntax };
    }
    if (source.brand !== undefined) {
      fields(source, ["brand"]);
      const brand = process_name.brand(source.brand);
      if (!brand) throw Error("InvalidBrand");
      return { brand };
    }
    fields(source, ["mix", "amount"]);
    if (
      !Array.isArray(source.mix) ||
      source.mix.length !== 2 ||
      typeof source.amount !== "number" ||
      !Number.isFinite(source.amount) ||
      source.amount < 0 ||
      source.amount > 100
    )
      throw Error("InvalidMix");
    const a = color(source.mix[0], depth + 1),
      b = color(source.mix[1], depth + 1);
    if (!a || !b) throw Error("InvalidColor");
    return { mix: [a, b], amount: source.amount };
  }
  if (typeof value !== "string" || (!Object.hasOwn(palette.colors, value) && !/^#[0-9a-fA-F]{6}$/.test(value)))
    throw Error("InvalidColor");
  return value as Color;
}
function spans(value: unknown): Span[] {
  if (!Array.isArray(value) || value.length > 16) throw Error("InvalidSpans");
  return value.map(v => {
    const s = object(v);
    fields(s, ["text", "color", "icon", "bold", "italic"]);
    const text = string(s.text, 512);
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text)) throw Error("ControlCharacter");
    const icon = s.icon === undefined ? undefined : process_name.brand(s.icon);
    if (icon === null) throw Error("InvalidBrand");
    for (const key of ["bold", "italic"])
      if (s[key] !== undefined && typeof s[key] !== "boolean") throw Error("InvalidStyle");
    return {
      text,
      ...(s.color === undefined ? {} : { color: color(s.color) }),
      ...(icon ? { icon } : {}),
      ...(s.bold ? { bold: true } : {}),
      ...(s.italic ? { italic: true } : {}),
    };
  });
}
/** Bound both depth and total work, including trees sent by raw programs. */
export function element(value: unknown, local = false): Element {
  let count = 0;
  const read = (value: unknown, depth: number): Element => {
    if (++count > max_nodes || depth >= max_depth) throw Error("DrawingTooLarge");
    const source = object(value);
    switch (source.kind) {
      case "text":
        fields(source, ["kind", "spans"]);
        return { kind: "text", spans: spans(source.spans) };
      case "button":
        fields(source, ["kind", "spans", "action", "slot"]);
        return {
          kind: "button",
          spans: spans(source.spans),
          action: local ? key(source.action) : reference(source.action),
          ...(source.slot === undefined ? {} : { slot: reference(string(source.slot, local ? 120 : 160)) }),
        };
      case "row":
      case "column":
        fields(source, ["kind", "children"]);
        if (!Array.isArray(source.children) || source.children.length > max_nodes) throw Error("DrawingTooLarge");
        return { kind: source.kind, children: source.children.map(child => read(child, depth + 1)) };
      default:
        throw Error("InvalidElement");
    }
  };
  return read(value, 0);
}
export function actions(node: Element | undefined): string[] {
  if (!node) return [];
  switch (node.kind) {
    case "button":
      return [node.action];
    case "text":
      return [];
    default:
      return node.children.flatMap(actions);
  }
}
export function mapActions(node: Element, map: (action: string) => string, slot?: (slot: string) => string): Element {
  switch (node.kind) {
    case "button":
      return { ...node, action: map(node.action), ...(slot ? { slot: slot(node.slot ?? node.action) } : {}) };
    case "text":
      return node;
    default:
      return { ...node, children: node.children.map(child => mapActions(child, map, slot)) };
  }
}
export function agentId(value: unknown): string {
  const id = string(value, 80);
  if (!/^(pane|headless):[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id.split(":")[1])))
    throw Error("InvalidAgent");
  return id;
}
export function view(value: unknown, local = false): View {
  const source = object(value);
  switch (source.kind) {
    case "decorate":
      fields(source, ["kind", "surface", "where", "color", "marker", "suffix", "content"]);
      if (source.surface !== undefined && !surfaces.includes(source.surface as Surface)) throw Error("InvalidSurface");
      return {
        kind: "decorate",
        ...(source.surface === undefined ? {} : { surface: source.surface as Surface }),
        where: selector(source.where),
        color: color(source.color),
        marker: color(source.marker),
        suffix: spans(source.suffix ?? []),
        ...(source.content === undefined ? {} : { content: element(source.content, local) }),
      };
    case "overlay": {
      fields(source, ["kind", "anchor", "lines", "content"]);
      const anchor = source.anchor ?? "top-right";
      if (anchor !== "top-right" && anchor !== "bottom-right" && anchor !== "top-left" && anchor !== "bottom-left")
        throw Error("InvalidAnchor");
      const lines = source.lines ?? [];
      if (!Array.isArray(lines) || lines.length > 12) throw Error("InvalidLines");
      return {
        kind: "overlay",
        anchor,
        lines: lines.map(spans),
        ...(source.content === undefined ? {} : { content: element(source.content, local) }),
      };
    }
    default:
      throw Error("InvalidView");
  }
}
export function command(value: unknown): { id: string | number | null; command: Command } {
  const source = object(value),
    id = source.id ?? null;
  if (
    id !== null &&
    !(typeof id === "string" && id.length <= 80) &&
    !(typeof id === "number" && Number.isSafeInteger(id))
  )
    throw Error("InvalidId");
  switch (source.op) {
    case "ui.focus":
      if (!Number.isSafeInteger(source.viewer) || Number(source.viewer) < 1) throw Error("InvalidViewer");
      return { id, command: { op: source.op, viewer: Number(source.viewer), agent: agentId(source.agent) } };
    case "ui.set":
      return { id, command: { op: source.op, key: key(source.key), view: view(source.view, true) } };
    case "ui.remove":
    case "kv.get":
    case "kv.delete":
      return { id, command: { op: source.op, key: key(source.key) } };
    case "kv.set":
      if (!Object.hasOwn(source, "value")) throw Error("MissingValue");
      return { id, command: { op: source.op, key: key(source.key), value: source.value } };
    case "subscribe":
      return {
        id,
        command: { op: source.op, subscription: subscription({ events: source.events, where: source.where }) },
      };
    default:
      throw Error("UnknownOp");
  }
}
/** Older daemons have no tricks; discard an invalid drawing at the wire boundary. */
export function views(value: unknown): View[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max_views * 16).flatMap(v => {
    try {
      return [view(v)];
    } catch {
      return [];
    }
  });
}
