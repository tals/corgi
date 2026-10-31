import * as action from "./action";
import * as bindings from "./bindings";
import * as keys from "./keys";
import type { Key } from "./keyboard";
import * as keymap from "./keymap";
import type { Preset } from "./keymap";

export type KeySet = { keys: string[] };
export type Value = string | KeySet;
export type Config = Record<string, Value | Value[]>;
export interface Shortcut {
  prefixed: boolean;
  keys: Key[];
}
export interface Entry {
  id: string;
  action: action.Action;
  title: string;
  indexed: boolean;
  shortcuts: Shortcut[];
  defaults: Shortcut[];
  custom: boolean;
}
export class InvalidKeys extends Error {
  name = "InvalidKeys";
}
function fail(message: string): never {
  throw new InvalidKeys(message);
}
export function id(a: action.Action): string {
  return a.name === "tab" || a.name === "goto-workspace"
    ? a.name
    : a.name + (a.value === undefined || (a.name === "resources" && a.value === 0) ? "" : `:${a.value}`);
}
export function target(name: string): action.Action {
  if (name === "tab" || name === "goto-workspace") return { name, value: 1 };
  const colon = name.indexOf(":");
  try {
    return action.parse(colon < 0 ? name : name.slice(0, colon), colon < 0 ? "" : name.slice(colon + 1));
  } catch {
    return fail(`Unknown shortcut action: ${name}`);
  }
}
export function chord(value: string): { key: Key; prefixed: boolean } {
  const prefixed = value.toLowerCase().startsWith("prefix+");
  const key = keys.parseChord(prefixed ? value.slice(7) : value);
  if (!key) return fail(`Invalid shortcut: ${value}`);
  if (key.codepoint === 27) return fail("Escape is reserved for canceling Corgi controls");
  return { key, prefixed };
}
export function parseShortcut(value: Value, indexed: boolean): Shortcut {
  let list: string[];
  if (typeof value === "string") {
    const range = /^(.*?)([0-9]|f\d+)\.\.([0-9]|f\d+)$/i.exec(value);
    if (range) {
      if (!indexed) return fail("Key ranges belong to an indexed action, such as tab");
      const f = range[2].toLowerCase().startsWith("f");
      const start = Number(f ? range[2].slice(1) : range[2]),
        end = Number(f ? range[3].slice(1) : range[3]);
      if (!Number.isInteger(end) || end < start || end - start >= 32) return fail(`Invalid key range: ${value}`);
      list = Array.from({ length: end - start + 1 }, (_, i) => range[1] + (f ? "f" : "") + (start + i));
    } else list = [value];
  } else {
    if (!indexed) return fail("Ordered key sets belong to an indexed action, such as tab");
    list = value.keys;
  }
  if (!list.length || list.length > 32) return fail("A key set needs between 1 and 32 keys");
  const parsed = list.map(chord);
  if (parsed.some(k => k.prefixed !== parsed[0].prefixed)) return fail("A key set must use one prefix mode");
  for (let i = 0; i < parsed.length; i++)
    if (parsed.slice(0, i).some(k => keys.same(k.key, parsed[i].key))) return fail("A key set cannot repeat a key");
  return { prefixed: parsed[0].prefixed, keys: parsed.map(k => k.key) };
}
export function parse(raw: unknown): Config {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("keys must be an object");
  const config: Config = {};
  for (const [name, value] of Object.entries(raw)) {
    const a = target(name),
      indexed = a.name === "tab" || a.name === "goto-workspace";
    if (id(a) !== name) return fail(`Use ${id(a)} for this action`);
    const list = Array.isArray(value) ? value : [value];
    if (list.length > 16) return fail(`Too many shortcuts for ${name}`);
    const valid: Value[] = list.map(v => {
      if (typeof v === "string") {
        parseShortcut(v, indexed);
        return v;
      }
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v).length === 1 &&
        Array.isArray(v.keys) &&
        v.keys.every((s: unknown) => typeof s === "string")
      ) {
        const set = { keys: [...v.keys] as string[] };
        parseShortcut(set, indexed);
        return set;
      }
      return fail(`Invalid shortcut value for ${name}`);
    });
    config[name] = Array.isArray(value) ? valid : valid[0];
  }
  return config;
}
export function overlaps(a: Shortcut, b: Shortcut): boolean {
  return a.prefixed === b.prefixed && a.keys.some(k => b.keys.some(other => keys.same(k, other)));
}
export function defaults(preset: Preset): Entry[] {
  const entries = new Map<string, Entry>();
  for (const b of bindings.table(preset)) {
    const name = id(b.action);
    let e = entries.get(name);
    if (!e) {
      e = {
        id: name,
        action: b.action,
        title: action.title(b.action),
        indexed: b.action.name === "tab" || b.action.name === "goto-workspace",
        shortcuts: [],
        defaults: [],
        custom: false,
      };
      entries.set(name, e);
    }
    const key = keys.normalize({ codepoint: b.key, mods: b.mods });
    if (e.indexed) {
      let set = e.defaults.find(s => s.prefixed === b.prefixed && s.keys.length === Number(b.action.value) - 1);
      if (!set) {
        set = { prefixed: b.prefixed, keys: [] };
        e.defaults.push(set);
      }
      set.keys.push(key);
    } else e.defaults.push({ prefixed: b.prefixed, keys: [key] });
  }
  for (const [name, type] of Object.entries(action.specs)) {
    const values =
      name === "tab" || name === "goto-workspace"
        ? [1]
        : type === "void"
          ? [undefined]
          : type === "layout.Direction"
            ? ["left", "down", "up", "right"]
            : type === "Split"
              ? ["right", "down"]
              : type === "Side"
                ? ["left", "right"]
                : [];
    for (const value of values) {
      const a = { name, ...(value === undefined ? {} : { value }) },
        nameId = id(a);
      if (!entries.has(nameId))
        entries.set(nameId, {
          id: nameId,
          action: a,
          title: action.title(a),
          indexed: name === "tab" || name === "goto-workspace",
          shortcuts: [],
          defaults: [],
          custom: false,
        });
    }
  }
  for (const e of entries.values()) e.shortcuts = [...e.defaults];
  return [...entries.values()];
}
/** Overrides win over ordinary preset bindings. Indexed sets stay indivisible. */
export function entries(preset: Preset, config: Config): Entry[] {
  const list = defaults(preset);
  for (const [name, value] of Object.entries(config)) {
    let e = list.find(e => e.id === name);
    if (!e) {
      const a = target(name);
      e = {
        id: name,
        action: a,
        title: action.title(a),
        indexed: a.name === "tab" || a.name === "goto-workspace",
        shortcuts: [],
        defaults: [],
        custom: false,
      };
      list.push(e);
    }
    e.custom = true;
    e.shortcuts = (Array.isArray(value) ? value : [value]).map(v => parseShortcut(v, e.indexed));
    for (let i = 0; i < e.shortcuts.length; i++)
      if (e.shortcuts.slice(0, i).some(s => overlaps(s, e!.shortcuts[i]))) fail(`Duplicate shortcut for ${e.title}`);
  }
  for (const e of list.filter(e => e.custom))
    for (const s of e.shortcuts)
      for (const other of list) {
        if (e === other || !other.shortcuts.some(k => overlaps(s, k))) continue;
        if (other.custom) fail(`${e.title} and ${other.title} use the same shortcut`);
        if (other.indexed) fail(`This key belongs to ${other.title}; change its whole key set first`);
        other.shortcuts = other.shortcuts.filter(k => !overlaps(s, k));
      }
  return list;
}
export function resolve(preset: Preset, config: Config): bindings.Binding[] {
  const base = bindings.table(preset);
  return entries(preset, config).flatMap(e =>
    e.shortcuts.flatMap(s =>
      s.keys.map((key, index) => {
        const a = e.indexed ? { name: e.action.name, value: index + 1 } : e.action;
        const original = base.find(
          b => id(b.action) === e.id && b.prefixed === s.prefixed && keys.same(key, { codepoint: b.key, mods: b.mods }),
        );
        return {
          key: key.codepoint,
          mods: key.mods,
          prefixed: s.prefixed,
          action: a,
          ...(original?.repeat ? { repeat: true } : {}),
        };
      }),
    ),
  );
}
export function serialize(s: Shortcut, indexed: boolean): Value {
  const names = s.keys.map(k => (s.prefixed ? "prefix+" : "") + keys.chordName(k));
  if (!indexed) return names[0];
  const first = names[0],
    match = /^(.*?)([0-9]|f\d+)$/.exec(first);
  if (match && names.length > 1) {
    const f = match[2].startsWith("f"),
      start = Number(f ? match[2].slice(1) : match[2]);
    if (names.every((name, i) => name === match[1] + (f ? "f" : "") + (start + i)))
      return first + ".." + (f ? "f" : "") + (start + names.length - 1);
  }
  return { keys: names };
}
export function conflicts(list: Entry[], name: string, shortcut: Shortcut): Entry[] {
  return list.filter(e => e.id !== name && e.shortcuts.some(s => overlaps(s, shortcut)));
}
/** Produces a whole replacement config, including explicitly moved conflicts. */
export function change(
  preset: Preset,
  config: Config,
  name: string,
  index: number,
  shortcut: Shortcut | null,
  move = false,
): Config {
  const list = entries(preset, config),
    e = list.find(e => e.id === name);
  if (!e) return fail(`Unknown action: ${name}`);
  const shortcuts = [...e.shortcuts];
  if (index < 0) {
    if (shortcut) shortcuts.push(shortcut);
  } else if (shortcut) shortcuts[index] = shortcut;
  else shortcuts.splice(index, 1);
  return replace(preset, config, name, shortcuts, move);
}
export function replace(preset: Preset, config: Config, name: string, shortcuts: Shortcut[], move = false): Config {
  const list = entries(preset, config),
    entry = list.find(e => e.id === name);
  if (!entry) return fail(`Unknown action: ${name}`);
  const next = { ...config };
  for (const other of list) {
    if (other.id === name || !other.shortcuts.some(s => shortcuts.some(k => overlaps(s, k)))) continue;
    if (!move) return fail(`Used by ${other.title}`);
    if (other.indexed && !entry.indexed) return fail(`Edit ${other.title}'s whole key set first`);
    next[other.id] = other.shortcuts
      .filter(s => !shortcuts.some(k => overlaps(s, k)))
      .map(s => serialize(s, other.indexed));
  }
  next[name] = shortcuts.map(s => serialize(s, entry.indexed));
  resolve(preset, next);
  return next;
}

export function restore(preset: Preset, config: Config, name: string): Config {
  const current = entries(preset, config),
    entry = current.find(e => e.id === name);
  if (!entry) return fail(`Unknown action: ${name}`);
  for (const shortcut of entry.defaults) {
    const owners = conflicts(current, name, shortcut).filter(e => e.custom);
    if (owners.length) return fail(`Default shortcut is used by ${owners.map(e => e.title).join(", ")}`);
  }
  const next = { ...config };
  delete next[name];
  resolve(preset, next);
  return next;
}
export function validatePrefix(config: Config, prefix: keymap.Prefix): void {
  const key = { codepoint: keymap.prefixByte(prefix), mods: {} };
  for (const [name, value] of Object.entries(config)) {
    const indexed = name === "tab" || name === "goto-workspace";
    for (const v of Array.isArray(value) ? value : [value])
      if (parseShortcut(v, indexed).keys.some(k => keys.same(k, key)))
        fail(`${keymap.prefixName(prefix)} is reserved for the prefix; choose another shortcut`);
  }
}
/** Compact display only; configuration always keeps explicit modifier names. */
export function display(s: Shortcut): string {
  const show = (k: Key) =>
    bindings
      .format({ key: k.codepoint, mods: k.mods, prefixed: s.prefixed, action: { name: "help" } })
      .replaceAll("Shift+", "⇧");
  let body = s.keys.map(show).join(" ");
  const serialized = serialize(s, s.keys.length > 1);
  const first = s.keys[0];
  const grouped = (label: string) =>
    [
      first.mods.ctrl ? "Ctrl" : "",
      first.mods.alt ? "Alt" : "",
      first.mods.super ? "Cmd" : "",
      first.mods.shift ? "⇧" : "",
      label,
    ]
      .filter(Boolean)
      .join("+");
  if (typeof serialized === "string" && serialized.includes("..")) {
    const range = /^(.*?)([0-9]|f\d+)\.\.([0-9]|f\d+)$/.exec(serialized)!;
    body = grouped("[" + range[2].toUpperCase() + ".." + range[3].toUpperCase() + "]");
  } else if (s.keys.length > 1 && s.keys.every(k => keys.same(k, { ...k, mods: first.mods })))
    body = grouped("(" + s.keys.map(k => show({ ...k, mods: {} })).join(", ") + ")");
  return (s.prefixed ? "◇ " : "") + body;
}
