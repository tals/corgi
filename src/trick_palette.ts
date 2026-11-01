import * as tricks from "./tricks";
import * as style from "./trick_style";
import * as text from "./text";

export type Key = string | number | boolean | null | readonly Key[];
export type Mapping = (key: Key) => Promise<tricks.Color>;
interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
const max_entries = 256;
function encode(value: unknown): string {
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
function saved(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const row = tricks.object(value);
  if (
    row.version !== 1 ||
    !Array.isArray(row.keys) ||
    row.keys.length > max_entries ||
    row.keys.some(key => typeof key !== "string" || text.byteLength(key) > 1024) ||
    new Set(row.keys).size !== row.keys.length
  )
    throw Error("InvalidPaletteStore");
  return row.keys;
}
/** Each mapper loads once and writes only new assignments, before returning a color. */
export function maps(store: Store) {
  const mappings = new Map<string, { colors: string; map: Mapping }>();
  return (name: string, colors: readonly tricks.Color[] = style.palette.identity): Mapping => {
    const key = tricks.key("palette." + tricks.key(name));
    if (!Array.isArray(colors) || !colors.length || colors.length > 32) throw Error("InvalidPalette");
    const palette = colors.map(color => {
      const value = tricks.color(color);
      if (!value) throw Error("InvalidPalette");
      return value;
    });
    const signature = JSON.stringify(palette),
      existing = mappings.get(name);
    if (existing) {
      if (existing.colors !== signature) throw Error("PaletteAlreadyDefined");
      return existing.map;
    }
    if (mappings.size >= 16) throw Error("TooManyPalettes");
    let keys: string[] | null = null,
      work: Promise<unknown> = Promise.resolve();
    const map: Mapping = value => {
      const encoded = encode(value);
      const result = work.then(async () => {
        keys ??= saved(await store.get(key));
        let index = keys.indexOf(encoded);
        if (index < 0) {
          if (keys.length >= max_entries) throw Error("PaletteFull");
          index = keys.length;
          const next = [...keys, encoded];
          await store.set(key, { version: 1, keys: next });
          keys = next;
        }
        return palette[index % palette.length];
      });
      work = result.catch(() => {});
      return result;
    };
    mappings.set(name, { colors: signature, map });
    return map;
  };
}
