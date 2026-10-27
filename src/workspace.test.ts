import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, Workspace } from "./workspace";
import * as layout from "./layout";
test("workspace renames bound UTF-8 names without splitting characters", () => {
  const workspace = new Workspace(1, "/tmp");
  workspace.rename("x".repeat(79) + "🐕");
  expect(workspace.name()).toBe("x".repeat(79));
  workspace.rename("🐕".repeat(100));
  expect(workspace.name()).toBe("🐕".repeat(20));
});
test("overlapping workspace creation keeps rename targets distinct", async () => {
  const s = new Store();
  const keep = await s.add("Keep", tmpdir());
  const ids = await Promise.all([s.add("Same", tmpdir()), s.add("Same", tmpdir())]);
  expect(new Set(s.items.map(w => w.id)).size).toBe(3);
  await s.edit(ids[1], "Renamed", tmpdir());
  expect([keep, ...ids].map(id => s.get(id)!.name())).toEqual(["Keep", "Same", "Renamed"]);
});
test("overlapping workspace creation respects the workspace limit", async () => {
  const s = new Store();
  for (let i = 0; i < layout.max_workspaces - 1; i++) await s.add("Same", tmpdir());
  await expect(Promise.all([s.add("One", tmpdir()), s.add("Two", tmpdir())])).rejects.toThrow("TooManyWorkspaces");
  expect(s.items).toHaveLength(layout.max_workspaces);
});
test("workspace names stay fixed across directory changes and save/load", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-ws-"));
  try {
    const folder = join(root, "项目 café");
    await mkdir(folder);
    const s = new Store(),
      id = await s.add("", folder),
      w = s.items[0];
    w.follow("/tmp/next");
    expect(w.name()).toBe("项目 café");
    const file = join(root, "workspaces.json");
    await s.save(file, id);
    const restored = new Store();
    expect(await restored.load(file)).toBe(id);
    expect(restored.items[0].name()).toBe("项目 café");
    s.rename(id, "My project");
    expect(() => s.rename(id, "")).toThrow("InvalidName");
    await expect(s.edit(id, " ", root)).rejects.toThrow("InvalidName");
    expect(w.cwd).toBe("/tmp/next");
    await s.save(file, id);
    await restored.load(file);
    restored.items[0].follow("/");
    expect(restored.items[0].name()).toBe("My project");
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
    s.items[0].follow("/tmp/moved");
    expect(s.items[0].name()).toBe("Default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("legacy empty names migrate from saved folders and remain fixed", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-ws-"));
  try {
    const file = join(root, "workspaces.json");
    for (const version of [1, 2]) {
      await writeFile(
        file,
        JSON.stringify({
          version,
          active: 1,
          next_id: 5,
          workspaces: [
            { id: 1, name: "", cwd: "/missing/项目 café/" },
            { id: 2, name: "", cwd: "/" },
            { id: 3, name: "Custom", cwd: "/elsewhere" },
            { id: 4, name: "", cwd: "/tmp/" + "x".repeat(100) },
          ],
        }),
      );
      const store = new Store();
      await store.load(file);
      const names = ["项目 café", "/", "Custom", "x".repeat(100)];
      expect(store.items.map(w => w.name())).toEqual(names);
      for (const w of store.items) w.follow("/changed");
      await store.save(file, 1);
      expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3);
      const next = new Store();
      await next.load(file);
      expect(next.items.map(w => w.name())).toEqual(names);
    }
    await writeFile(file, JSON.stringify({ version: 99 }));
    await expect(new Store().load(file)).rejects.toThrow("UnsupportedStateVersion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
