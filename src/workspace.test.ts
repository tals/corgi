import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, Workspace } from "./workspace";
import * as layout from "./layout";
test("a workspace takes its folder's name at creation and keeps it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corgi-ws-")));
  try {
    const folder = join(root, "项目 café");
    await mkdir(folder);
    const s = new Store(),
      id = await s.add("", folder),
      w = s.items[0];
    expect(w.name()).toBe("项目 café");
    await s.edit(id, null, root);
    expect([w.cwd, w.name()]).toEqual([root, "项目 café"]);
    s.rename(id, "My project");
    const file = join(root, "workspaces.json");
    await s.save(file, id);
    expect(JSON.parse(await readFile(file, "utf8")).workspaces[0].name).toBe("My project");
    const restored = new Store();
    expect(await restored.load(file)).toBe(id);
    expect(restored.items[0].name()).toBe("My project");
    expect(() => s.rename(id, " ")).toThrow("InvalidName");
    await expect(s.edit(id, "", folder)).rejects.toThrow("InvalidName");
    expect([w.cwd, w.name()]).toEqual([root, "My project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("workspace names keep whole characters within the limit", () => {
  const w = new Workspace(1, "/tmp");
  w.rename("x".repeat(79) + "🐕");
  expect(w.name()).toBe("x".repeat(79));
  w.rename("🐕".repeat(100));
  expect(w.name()).toBe("🐕".repeat(20));
  w.rename("a\tb");
  expect(w.name()).toBe("a_b");
});
test("old workspace state names its folder-named workspaces for their folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-ws-"));
  try {
    const file = join(root, "workspaces.json");
    for (const version of [1, 2]) {
      await writeFile(
        file,
        JSON.stringify({
          version,
          active: 1,
          next_id: 4,
          workspaces: [
            { id: 1, name: "", cwd: "/missing/项目 café/", pinned: true },
            { id: 2, name: "", cwd: "/" },
            { id: 3, name: "Custom", cwd: "/elsewhere" },
          ],
        }),
      );
      const s = new Store();
      await s.load(file);
      expect(s.items.map(w => w.name())).toEqual(["项目 café", "/", "Custom"]);
      await s.save(file, 1);
      expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3);
    }
    await writeFile(file, JSON.stringify({ version: 99 }));
    await expect(new Store().load(file)).rejects.toThrow("UnsupportedStateVersion");
    await writeFile(
      file,
      JSON.stringify({ version: 3, active: 1, next_id: 2, workspaces: [{ id: 1, name: "", cwd: "/" }] }),
    );
    await expect(new Store().load(file)).rejects.toThrow("InvalidWorkspaceState");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("overlapping workspace creation keeps ids distinct", async () => {
  const s = new Store();
  const ids = await Promise.all([s.add("One", tmpdir()), s.add("Two", tmpdir())]);
  expect(new Set(ids).size).toBe(2);
  s.items = [];
  for (let i = 0; i < layout.max_workspaces - 1; i++) await s.add("", tmpdir());
  await expect(Promise.all([s.add("One", tmpdir()), s.add("Two", tmpdir())])).rejects.toThrow("TooManyWorkspaces");
  expect(s.items).toHaveLength(layout.max_workspaces);
});
test("a rename keeps a folder that disappeared and its Git state; moving there fails", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corgi-ws-")));
  try {
    const gone = join(root, "gone"),
      s = new Store();
    await mkdir(gone);
    const id = await s.add("", gone),
      w = s.items[0];
    await rm(gone, { recursive: true });
    const epoch = w.git_epoch;
    await s.edit(id, "Renamed", null);
    expect([w.cwd, w.name(), w.git_epoch]).toEqual([gone, "Renamed", epoch]);
    await expect(s.edit(id, "Other", gone)).rejects.toThrow();
    expect(w.name()).toBe("Renamed");
    await s.edit(id, null, root);
    expect([w.cwd, w.name(), w.git_epoch]).toEqual([root, "Renamed", epoch + 1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a workspace named like another takes the next number after the highest", async () => {
  const s = new Store();
  const name = async (n: string, cwd = "/tmp") => {
    const id = await s.add(n, cwd);
    s.distinguish(id);
    return s.get(id)!.name();
  };
  expect(await name("Foo")).toBe("Foo");
  expect(await name("Foo")).toBe("Foo: 2");
  expect(await name("Foo: 4")).toBe("Foo: 4");
  expect(await name("Foo")).toBe("Foo: 5");
  expect(await name("Foo: 4")).toBe("Foo: 6");
  // A name the folder gives is numbered too.
  expect(await name("")).toBe("tmp");
  expect(await name("")).toBe("tmp: 2");
  expect(await name("Foo: 99999999999999999999")).toBe("Foo: 99999999999999999999");
  expect(await name("Foo")).toBe("Foo: 7");
  // A name too long for its number is cut, and the cut names count too.
  const long = "L".repeat(layout.max_label);
  expect(await name(long)).toBe(long);
  expect(await name(long)).toBe("L".repeat(layout.max_label - 3) + ": 2");
  expect(await name(long)).toBe("L".repeat(layout.max_label - 3) + ": 3");
});
