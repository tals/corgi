import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as preferences from "./preferences";
import { observe } from "./keybinding_file";

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
