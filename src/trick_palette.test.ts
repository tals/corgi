import { expect, test } from "bun:test";
import * as trickPalette from "./trick_palette";
import * as style from "./trick_style";

function store() {
  const values = new Map<string, unknown>();
  let reads = 0,
    writes = 0,
    fail = false;
  const io = {
    async get(key: string) {
      reads++;
      return structuredClone(values.get(key));
    },
    async set(key: string, value: unknown) {
      if (fail) throw Error("DiskFull");
      writes++;
      values.set(key, structuredClone(value));
    },
  };
  return {
    values,
    io,
    counts: () => [reads, writes],
    fail: (on: boolean) => {
      fail = on;
    },
  };
}

test("palette maps distinguish accounts and providers, remember slots and avoid repeat I/O", async () => {
  const s = store(),
    map = trickPalette.maps(s.io)("accounts");
  const keys = [
    ["claude", ""],
    ["claude", "/work"],
    ["claude", "/client"],
    ["codex", "/work"],
  ];
  const colors = await Promise.all(keys.map(map));
  expect(colors).toEqual(style.palette.identity.slice(0, 4));
  for (let i = 0; i < keys.length; i++) expect(await map(keys[i])).toEqual(colors[i]);
  expect(s.counts()).toEqual([1, 4]);
  const restored = trickPalette.maps(s.io)("accounts");
  for (let i = keys.length - 1; i >= 0; i--) expect(await restored(keys[i])).toEqual(colors[i]);
  expect(s.counts()).toEqual([2, 4]);
});

test("custom palettes repeat after all slots are used, with separate mappings per name", async () => {
  const s = store(),
    maps = trickPalette.maps(s.io),
    colors = [style.palette.syntax.type, style.palette.syntax.number];
  const map = maps("projects", colors);
  expect(maps("projects", colors)).toBe(map);
  expect(await Promise.all(["a", "b", "a", "c"].map(map))).toEqual([colors[0], colors[1], colors[0], colors[0]]);
  expect(s.counts()).toEqual([1, 3]);
  expect(await maps("labels", colors)("b")).toEqual(colors[0]);
  // Changing a palette on the next run keeps the saved slot, not a stale RGB value.
  expect(await trickPalette.maps(s.io)("projects", [...colors].reverse())("b")).toEqual(colors[0]);
});

test("palette assignment commits only after a durable write and serializes concurrent calls", async () => {
  const s = store(),
    map = trickPalette.maps(s.io)("accounts");
  s.fail(true);
  await expect(map("failed")).rejects.toThrow("DiskFull");
  expect(s.values.size).toBe(0);
  s.fail(false);
  expect(await Promise.all([map("same"), map("same"), map("other")])).toEqual([
    style.palette.identity[0],
    style.palette.identity[0],
    style.palette.identity[1],
  ]);
  expect(s.counts()).toEqual([1, 2]);
});

test("palette maps reject corrupt state, ambiguous keys and unbounded mappings", async () => {
  const s = store(),
    maps = trickPalette.maps(s.io);
  expect(() => maps("empty", [])).toThrow("InvalidPalette");
  const map = maps("accounts");
  expect(() => maps("accounts", ["warm"])).toThrow("PaletteAlreadyDefined");
  expect(() => map(NaN)).toThrow("InvalidPaletteKey");
  expect(() => map("x".repeat(1025))).toThrow("PaletteKeyTooLarge");
  s.values.set("palette.accounts", { version: 2, keys: [] });
  await expect(map("one")).rejects.toThrow("InvalidPaletteStore");
  expect(s.counts()).toEqual([1, 0]);
  s.values.clear();
  for (let i = 0; i < 256; i++) await map(i);
  await expect(map(256)).rejects.toThrow("PaletteFull");
  expect(await map(0)).toEqual(style.palette.identity[0]);
});
