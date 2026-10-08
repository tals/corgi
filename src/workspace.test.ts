import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "./workspace";
test("automatic workspace names follow folders while overrides survive save and load", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-ws-"));
  try {
    const s = new Store(),
      id = await s.add("", "."),
      w = s.items[0];
    w.follow("/tmp/项目");
    expect(w.name()).toBe("项目");
    s.rename(id, "My project");
    w.follow("/tmp/next");
    expect(w.name()).toBe("My project");
    const file = join(root, "workspaces.json");
    await s.save(file, id);
    const restored = new Store();
    expect(await restored.load(file)).toBe(id);
    expect(restored.items[0].name()).toBe("My project");
    s.rename(id, "");
    await s.save(file, id);
    await restored.load(file);
    restored.items[0].follow("/");
    expect(restored.items[0].name()).toBe("/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("old workspace state drops pins and preserves all existing names", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-ws-"));
  try {
    const file = join(root, "workspaces.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        active: 1,
        next_id: 3,
        workspaces: [
          { id: 1, name: "Default", cwd: "/tmp/project", pinned: true },
          { id: 2, name: "Custom", cwd: "/tmp/other", pinned: true },
        ],
      }),
    );
    const s = new Store();
    await s.load(file);
    expect(s.items.map(w => w.name())).toEqual(["Default", "Custom"]);
    s.rename(1, "");
    s.items[0].follow("/tmp/moved");
    expect(s.items[0].name()).toBe("moved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
