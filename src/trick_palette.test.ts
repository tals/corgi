import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as palette from "./trick_palette";
import * as style from "./trick_style";
import { Store } from "./trick_palette_store";
async function eventually(read: () => Promise<unknown>, expected: unknown) {
  const end = Date.now() + 2000;
  let value: unknown;
  while (JSON.stringify((value = await read())) !== JSON.stringify(expected) && Date.now() < end) await Bun.sleep(10);
  expect(value).toEqual(expected);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "corgi-palettes-"));
  const stores: Store[] = [];
  const make = (runtime: string, owner: string) => {
    let calls = 0;
    const store = new Store(join(root, runtime), join(root, "global"), (ref, state) => {
      const p = palette.ref(ref);
      if (p.owner === null || p.owner === owner) maps.update(p.name, state);
    });
    stores.push(store);
    const maps = palette.maps(async c => {
      calls++;
      if (c.op === "palette.define") return store.define(owner, c.name, c.colors);
      if (c.op === "palette.assign") return store.assign(palette.reference(owner, c.name), c.key);
      throw Error("UnexpectedCommand");
    });
    return { store, maps, calls: () => calls };
  };
  return {
    root,
    make,
    close() {
      for (const s of stores) s.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("local palettes keep durable slots and cached lookups, separately by Trick and runtime", async () => {
  const f = fixture();
  try {
    const a = f.make("one", "a"),
      map = a.maps("accounts");
    expect(await Promise.all(["work", "home", "work"].map(map))).toEqual([
      style.palette.identity[0],
      style.palette.identity[1],
      style.palette.identity[0],
    ]);
    expect(a.calls()).toBe(3);
    const restored = f.make("one", "a").maps("accounts");
    expect(await restored("home")).toEqual(style.palette.identity[1]);
    expect(await f.make("one", "b").maps("accounts")("home")).toEqual(style.palette.identity[0]);
    expect(await f.make("two", "a").maps("accounts")("home")).toEqual(style.palette.identity[0]);
    expect(() => a.maps("accounts", ["warm"])).toThrow("PaletteAlreadyDefined");
  } finally {
    f.close();
  }
});
test("global palettes share allocation and live overrides across runtimes without restarting maps", async () => {
  const f = fixture();
  try {
    const a = f.make("one", "a"),
      b = f.make("two", "b"),
      left = a.maps("globals.accounts"),
      right = b.maps("globals.accounts");
    expect(await left("work")).toEqual(await right("work"));
    const result = await Promise.all([left("home"), right("client")]);
    expect(result[0]).not.toEqual(result[1]);
    await b.store.set("globals.accounts", "work", "#cc8844");
    await eventually(() => left("work"), "#cc8844");
    await a.store.set("globals.accounts", "work", null);
    await eventually(() => right("work"), style.palette.identity[0]);
    expect(a.store.get("globals.accounts").keys).toHaveLength(3);
    await expect(b.store.define("b", "globals.accounts", ["warm"])).rejects.toThrow("SharedPaletteConflict");
    expect(await a.maps("globals.custom", ["warm", "accent"])("work")).toBe("warm");
    expect(await b.maps("globals.custom")("home")).toBe("accent");
  } finally {
    f.close();
  }
});
test("CLI overrides can precede a Trick, reset keeps slots, and legacy keys retain their assignments", async () => {
  const f = fixture();
  try {
    const a = f.make("one", "a");
    await a.store.set("a/accounts", ["provider", "work"], "warm");
    const map = a.maps("accounts");
    expect(await map(["provider", "work"])).toBe("warm");
    expect(await map("other")).toEqual(style.palette.identity[1]);
    await a.store.set("a/accounts", null, null, true);
    expect(await map(["provider", "work"])).toEqual(style.palette.identity[0]);
    await a.store.define("a", "legacy", [...style.palette.identity], { version: 1, keys: ['"first"', '"second"'] });
    expect(await a.maps("legacy")("second")).toEqual(style.palette.identity[1]);
  } finally {
    f.close();
  }
});
test("palette limits and malformed stores fail without destroying saved choices", async () => {
  const f = fixture();
  try {
    const a = f.make("one", "a"),
      map = a.maps("bounded", ["warm", "accent"]);
    expect(() => map(NaN)).toThrow("InvalidPaletteKey");
    expect(() => map("x".repeat(1025))).toThrow("PaletteKeyTooLarge");
    expect(() => a.maps("empty", [])).toThrow("InvalidPalette");
    for (let i = 0; i < 256; i++) await map(i);
    await expect(map(256)).rejects.toThrow("PaletteFull");
    expect(await map(0)).toBe("warm");
    const file = join(f.root, "one/a/bounded.json");
    writeFileSync(file, "broken");
    await expect(a.store.set("a/bounded", 0, "accent")).rejects.toThrow();
  } finally {
    f.close();
  }
});
test("palette choices persist across reloads and global owners survive restarts", async () => {
  const f = fixture();
  try {
    const a = f.make("one", "alpha"),
      b = f.make("two", "beta");
    const left = a.maps("globals.shared"),
      right = b.maps("globals.shared");
    await left("work");
    await right("home");
    await b.store.scheme("globals.shared", "set2");
    await eventually(() => left("work"), style.palette.schemes.set2[0]);
    await a.store.set("globals.shared", "work", "steelblue");
    expect(await left("work")).toBe("#4682b4");
    await b.store.scheme("globals.shared", null);
    await eventually(() => right("home"), style.palette.identity[1]);
    expect(await f.make("one", "alpha").maps("globals.shared")("work")).toBe("#4682b4");
    const summary = a.store.list()[0];
    expect(summary.owners).toEqual(["alpha", "beta"]);
    expect(summary.preview[0]).toBe("#4682b4");
    expect(await a.maps("custom", "tableau10")("work")).toBe(style.palette.schemes.tableau10[0]);
  } finally {
    f.close();
  }
});
