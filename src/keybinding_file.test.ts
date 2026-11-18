import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as preferences from "./preferences";
import { observe } from "./keybinding_file";
import { flock } from "./native_bridge";

/** config.json as live reload reads it, each time it changes. */
const watch = (file: string, changed: (p: preferences.Preferences | null) => void) =>
  observe(file, () => changed(preferences.inspectConfig(file).prefs));
const scratch = (dir: string): preferences.Paths => ({
  viewer: join(dir, "viewer.json"),
  config: join(dir, "config.json"),
});

test("directory watching survives malformed edits and atomic replacements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-keys-")),
    file = join(dir, "config.json");
  let notify: ((p: preferences.Preferences | null) => void) | null = null;
  const close = watch(file, p => notify?.(p));
  const edit = (write: () => void) =>
    new Promise<preferences.Preferences | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Watcher did not fire")), 2000);
      notify = p => {
        clearTimeout(timer);
        notify = null;
        resolve(p);
      };
      write();
    });
  try {
    const first = await edit(() => writeFileSync(file, JSON.stringify({ keys: { new: "prefix+y" } })));
    expect(first?.keys).toEqual({ new: "prefix+y" });
    expect(await edit(() => writeFileSync(file, '{"keys":'))).toBeNull();
    const replacement = await edit(() => {
      writeFileSync(file + ".tmp", JSON.stringify({ keys: { new: "ctrl+y" } }));
      renameSync(file + ".tmp", file);
    });
    expect(replacement?.keys).toEqual({ new: "ctrl+y" });
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving shortcut changes preserves other preferences and rejects stale or malformed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-keys-")),
    where = scratch(dir);
  try {
    const base = new preferences.Preferences();
    preferences.update({ sidebar_width: 35, theme: "animal_style" }, where);
    preferences.updateKeys(base, { new: "prefix+y" }, where);
    expect(preferences.read(where)).toMatchObject({ sidebar_width: 35, theme: "animal_style" });
    expect(() => preferences.updateKeys(base, { new: "prefix+z" }, where)).toThrow("changed on disk");
    writeFileSync(where.config, "{");
    expect(() => preferences.updateKeys(base, {}, where)).toThrow("repair");
    expect(() => preferences.update({ theme: "corgi" }, where)).toThrow("repair");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live reload distinguishes inaccessible paths from deleted preferences and recovers", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-keys-unreadable-")),
    dir = join(root, "config"),
    file = join(dir, "config.json");
  mkdirSync(dir);
  writeFileSync(file, JSON.stringify({ keys: { new: "prefix+y" } }));
  const events: (preferences.Preferences | null)[] = [];
  const close = watch(file, p => events.push(p));
  const until = async (count: number) => {
    const deadline = Date.now() + 2500;
    while (events.length < count && Date.now() < deadline) await Bun.sleep(20);
    expect(events).toHaveLength(count);
  };
  try {
    renameSync(dir, join(root, "old"));
    symlinkSync("config", dir);
    await until(1);
    expect(events[0]).toBeNull();
    rmSync(dir);
    renameSync(join(root, "old"), dir);
    await until(2);
    expect(events[1]?.keys.new).toBe("prefix+y");
    rmSync(file);
    await until(3);
    expect(events[2]).toEqual(new preferences.Preferences());
  } finally {
    close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live reload follows directory removal, recreation and replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-keys-directory-")),
    dir = join(root, "config"),
    file = join(dir, "config.json");
  const events: (preferences.Preferences | null)[] = [];
  const close = watch(file, p => events.push(p));
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 2500;
    while (!condition() && Date.now() < deadline) await Bun.sleep(20);
    expect(condition()).toBe(true);
  };
  const last = () => events.at(-1);
  try {
    mkdirSync(dir);
    writeFileSync(file, JSON.stringify({ keys: { new: "prefix+y" } }));
    await until(() => last()?.keys.new === "prefix+y");
    rmSync(dir, { recursive: true });
    await until(() => last()?.keys.new === undefined);
    mkdirSync(dir);
    writeFileSync(file, JSON.stringify({ keys: { new: "ctrl+y" } }));
    await until(() => last()?.keys.new === "ctrl+y");
    const replacement = join(root, "replacement");
    mkdirSync(replacement);
    writeFileSync(join(replacement, "config.json"), JSON.stringify({ keys: { new: "alt+y" } }));
    renameSync(dir, join(root, "old"));
    renameSync(replacement, dir);
    await until(() => last()?.keys.new === "alt+y");
    writeFileSync(file, JSON.stringify({ keys: { new: "prefix+ctrl+y" } }));
    await until(() => last()?.keys.new === "prefix+ctrl+y");
    close();
    const count = events.length;
    writeFileSync(file, JSON.stringify({ keys: { new: "ctrl+alt+y" } }));
    await Bun.sleep(300);
    expect(events).toHaveLength(count);
  } finally {
    close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("another process cannot save preferences while a writer holds the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-keys-lock-")),
    where = scratch(dir);
  const fd = openSync(where.viewer + ".lock", "a", 0o600);
  const module = new URL("./preferences.ts", import.meta.url).href;
  const attempt = (keys: boolean) => {
    const source = `import * as p from ${JSON.stringify(module)};
      try {
        const where = JSON.parse(process.argv.at(-1));
        ${keys ? 'p.updateKeys(new p.Preferences(), { new: "prefix+y" }, where)' : "p.update({ sidebar_width: 60 }, where)"};
        console.log("saved");
      } catch (e) { console.log(e.message); }`;
    // The test's own variables, which keep the child off the person's files.
    const child = Bun.spawnSync([process.execPath, "-e", source, JSON.stringify(where)], { env: process.env });
    expect(child.exitCode).toBe(0);
    return child.stdout.toString();
  };
  try {
    preferences.write(new preferences.Preferences(), where);
    expect(flock(fd)).toBe(true);
    expect(attempt(true)).toContain("another viewer");
    expect(attempt(false)).toContain("another viewer");
    expect(preferences.read(where).keys).toEqual({});
    writeFileSync(where.config, JSON.stringify({ keys: { new: "alt+y" } }));
    flock(fd, false);
    expect(attempt(true)).toContain("changed on disk");
    expect(attempt(false)).toContain("saved");
    expect(preferences.read(where).keys).toEqual({ new: "alt+y" });
    expect(preferences.read(where).sidebar_width).toBe(60);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});
