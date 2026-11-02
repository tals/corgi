import * as tricks from "./tricks";
import * as text from "./text";

type Atom = string | number | boolean | null;
type Values<T> = Atom | readonly T[];
export type Key = Values<Values<Values<Values<Atom>>>>;
export type Mapping = (key: Key) => Promise<tricks.Color>;
export interface State {
  version: 1;
  revision: number;
  colors: tricks.Color[];
  keys: string[];
  overrides: (tricks.Color | null)[];
}
export interface Summary {
  ref: string;
  entries: number;
}
export interface Info extends Summary {
  colors: tricks.Color[];
  assignments: { key: Key; label: string; color: tricks.Color; override: boolean }[];
}
export const max_entries = 256;
export function encode(value: unknown): string {
  const valid = (v: unknown, depth: number): boolean => {
    if (depth > 4) return false;
    if (Array.isArray(v)) return v.length <= 16 && v.every(item => valid(item, depth + 1));
    return (
      v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
    );
  };
  if (!valid(value, 0)) throw Error("InvalidPaletteKey");
  const key = JSON.stringify(value);
  if (text.byteLength(key) > 1024) throw Error("PaletteKeyTooLarge");
  return key;
}
export function colors(value: unknown): tricks.Color[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw Error("InvalidPalette");
  return value.map(v => {
    const color = tricks.color(v);
    if (!color) throw Error("InvalidPalette");
    return color;
  });
}
export function name(value: unknown): string {
  const result = tricks.key(value);
  if (result === "globals" || result === "globals.") throw Error("InvalidPaletteName");
  return result;
}
export function reference(owner: string, value: unknown): string {
  const palette = name(value);
  return palette.startsWith("globals.") ? palette : tricks.key(owner) + "/" + palette;
}
export function ref(value: string): { owner: string | null; name: string } {
  if (value.startsWith("globals.")) return { owner: null, name: name(value) };
  const parts = value.split("/");
  if (parts.length !== 2 || parts[1].startsWith("globals.")) throw Error("InvalidPaletteReference");
  return { owner: tricks.key(parts[0]), name: name(parts[1]) };
}
export function keys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > max_entries) throw Error("InvalidPaletteStore");
  const result = value.map(key => {
    if (typeof key !== "string" || encode(JSON.parse(key)) !== key) throw Error("InvalidPaletteStore");
    return key;
  });
  if (new Set(result).size !== result.length) throw Error("InvalidPaletteStore");
  return result;
}
export function read(value: unknown): State {
  const v = tricks.object(value),
    k = keys(v.keys);
  if (
    v.version !== 1 ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 0 ||
    !Array.isArray(v.overrides) ||
    v.overrides.length !== k.length
  )
    throw Error("InvalidPaletteStore");
  return {
    version: 1,
    revision: Number(v.revision),
    colors: colors(v.colors),
    keys: k,
    overrides: v.overrides.map(v => (v === null ? null : (tricks.color(v) ?? null))),
  };
}
export function automatic(state: State, index: number): tricks.Color {
  return state.colors[index % state.colors.length];
}
export function color(state: State, index: number): tricks.Color {
  return state.overrides[index] ?? automatic(state, index);
}
export function colorText(color: tricks.Color): string {
  if (typeof color === "string") return color;
  if ("syntax" in color) return "syntax." + color.syntax;
  if ("brand" in color) return "brand." + color.brand;
  return JSON.stringify(color);
}
export function parseColor(value: string): tricks.Color {
  return tricks.color(
    value.startsWith("syntax.")
      ? { syntax: value.slice(7) }
      : value.startsWith("brand.")
        ? { brand: value.slice(6) }
        : value.startsWith("{")
          ? JSON.parse(value)
          : value,
  )!;
}
export function summaries(value: unknown): Summary[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).map(v => {
    const row = tricks.object(v);
    ref(String(row.ref));
    if (!Number.isSafeInteger(row.entries) || Number(row.entries) < 0 || Number(row.entries) > max_entries)
      throw Error("InvalidPalette");
    return { ref: String(row.ref), entries: Number(row.entries) };
  });
}
export function info(value: unknown): Info {
  const row = tricks.object(value);
  const summary = summaries([row])[0];
  if (!Array.isArray(row.assignments) || row.assignments.length !== summary.entries) throw Error("InvalidPalette");
  return {
    ...summary,
    colors: colors(row.colors),
    assignments: row.assignments.map(value => {
      const a = tricks.object(value);
      return {
        key: JSON.parse(encode(a.key)),
        label: typeof a.label === "string" ? a.label.slice(0, 1024) : "",
        color: tricks.color(a.color) ?? "text",
        override: a.override === true,
      };
    }),
  };
}
/** The daemon owns allocation and overrides; repeat lookups stay in memory. */
export function maps(call: (command: tricks.Command) => Promise<unknown>) {
  const mappings = new Map<string, { signature: string; state: State | null; map: Mapping }>();
  const update = (name: string, state: State) => {
    const found = mappings.get(name);
    if (found && (!found.state || state.revision >= found.state.revision)) found.state = state;
  };
  const create = (value: string, supplied?: readonly tricks.Color[]): Mapping => {
    const n = name(value),
      palette = supplied === undefined ? undefined : colors(supplied),
      signature = JSON.stringify(palette ?? null),
      found = mappings.get(n);
    if (found) {
      if (found.signature !== signature) throw Error("PaletteAlreadyDefined");
      return found.map;
    }
    if (mappings.size >= 16) throw Error("TooManyPalettes");
    const entry = { signature, state: null as State | null, map: null! as Mapping };
    mappings.set(n, entry);
    let work: Promise<unknown> = Promise.resolve();
    entry.map = value => {
      const key = encode(value);
      const result = work.then(async () => {
        if (!entry.state) update(n, read(await call({ op: "palette.define", name: n, colors: palette })));
        let index = entry.state!.keys.indexOf(key);
        if (index < 0) {
          update(n, read(await call({ op: "palette.assign", name: n, key })));
          index = entry.state!.keys.indexOf(key);
        }
        return color(entry.state!, index);
      });
      work = result.catch(() => {});
      return result;
    };
    return entry.map;
  };
  return Object.assign(create, { update });
}
