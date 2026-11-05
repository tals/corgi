import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Watcher, source } from "./trick_watch";

test("autoreload filters source files from logs, temporary saves and generated output", () => {
  for (const name of ["main.mjs", "helper.ts", "trick.toml", "colors.json", "main.cts"])
    expect(source(name)).toBe(true);
  for (const name of ["events.jsonl", "watch", ".main.mjs", "main.ts~", "main.ts.swp"])
    expect(source(name)).toBe(false);
});

test("native trick watches follow atomic saves and nested imports, but ignore dependencies and close cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-trick-watch-"));
  const folder = join(root, "example"),
    nested = join(folder, "lib"),
    dependency = join(folder, "node_modules");
  mkdirSync(nested, { recursive: true });
  mkdirSync(dependency);
  const calls: string[][] = [];
  const watcher = new Watcher(root, names => calls.push([...names]));
  const until = async (count: number) => {
    const end = Date.now() + 4000;
    while (calls.length < count && Date.now() < end) await Bun.sleep(20);
    expect(calls).toHaveLength(count);
    expect(calls[count - 1]).toEqual(["example"]);
  };
  try {
    writeFileSync(join(folder, ".save"), "first");
    renameSync(join(folder, ".save"), join(folder, "main.mjs"));
    await until(1);
    writeFileSync(join(nested, "helper.ts"), "export const value = 1;");
    await until(2);
    writeFileSync(join(dependency, "index.js"), "ignored");
    writeFileSync(join(folder, "events.jsonl"), "{}\n");
    writeFileSync(join(folder, "watch"), "ignored");
    await Bun.sleep(350);
    expect(calls).toHaveLength(2);
    writeFileSync(join(folder, "main.mjs"), "pending");
    watcher.close();
    await Bun.sleep(350);
    expect(calls).toHaveLength(2);
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});
