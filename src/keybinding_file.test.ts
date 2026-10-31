import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as preferences from "./preferences";
import { observe } from "./keybinding_file";
import { flock } from "./native_bridge";

test("directory watching survives malformed edits and atomic replacements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-keys-")),
    file = join(dir, "viewer.json");
  let notify: ((p: preferences.Preferences | null) => void) | null = null;
  const close = observe(file, p => notify?.(p));
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
    file = join(dir, "viewer.json");
  try {
    const base = new preferences.Preferences();
    preferences.updateFile(file, { sidebar_width: 35 });
    preferences.updateKeys(base, { new: "prefix+y" }, file);
    expect(preferences.read(file).sidebar_width).toBe(35);
    expect(() => preferences.updateKeys(base, { new: "prefix+z" }, file)).toThrow("changed on disk");
    writeFileSync(file, "{");
    expect(() => preferences.updateKeys(base, {}, file)).toThrow("repair");
    expect(() => preferences.updateFile(file, { sidebar_width: 36 })).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live reload follows directory removal, recreation and replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-keys-directory-")),
    dir = join(root, "state"),
    file = join(dir, "viewer.json");
  const events: (preferences.Preferences | null)[] = [];
  const close = observe(file, p => events.push(p));
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
    writeFileSync(join(replacement, "viewer.json"), JSON.stringify({ keys: { new: "alt+y" } }));
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
    file = join(dir, "viewer.json");
  const fd = openSync(file + ".lock", "a", 0o600);
  const module = new URL("./preferences.ts", import.meta.url).href;
  const attempt = (keys: boolean) => {
    const source = `import * as p from ${JSON.stringify(module)};
      try {
        const file = process.argv.at(-1);
        ${keys ? 'p.updateKeys(new p.Preferences(), { new: "prefix+y" }, file)' : "p.updateFile(file, { sidebar_width: 60 })"};
        console.log("saved");
      } catch (e) { console.log(e.message); }`;
    const child = Bun.spawnSync([process.execPath, "-e", source, file]);
    expect(child.exitCode).toBe(0);
    return child.stdout.toString();
  };
  try {
    preferences.write(file, new preferences.Preferences());
    expect(flock(fd)).toBe(true);
    expect(attempt(true)).toContain("another viewer");
    expect(attempt(false)).toContain("another viewer");
    expect(preferences.read(file).keys).toEqual({});
    writeFileSync(file, JSON.stringify({ keys: { new: "alt+y" } }));
    flock(fd, false);
    expect(attempt(true)).toContain("changed on disk");
    expect(attempt(false)).toContain("saved");
    expect(preferences.read(file).keys).toEqual({ new: "alt+y" });
    expect(preferences.read(file).sidebar_width).toBe(60);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});
