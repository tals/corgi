import { test, expect } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "./workspace";
test("automatic workspace names follow folders while overrides survive save and load", async () => {
  const root = await mkdtemp(join(tmpdir(), "corgi-ws-"));
  try {
    const s = new Store(),
      id = await s.add("", "."),
      w = s.items[0];
    w.move("/tmp/项目");
    expect(w.name()).toBe("项目");
    s.rename(id, "My project");
    w.move("/tmp/next");
    expect(w.name()).toBe("My project");
    const file = join(root, "workspaces.json");
    await s.save(file, id);
    const restored = new Store();
    expect(await restored.load(file)).toBe(id);
    expect(restored.items[0].name()).toBe("My project");
    s.rename(id, "");
    await s.save(file, id);
    await restored.load(file);
    restored.items[0].move("/");
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
    s.items[0].move("/tmp/moved");
    expect(s.items[0].name()).toBe("moved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    await expect(s.edit(id, "Renamed", gone)).rejects.toThrow();
    await s.edit(id, "", root);
    expect([w.cwd, w.git_epoch]).toEqual([root, epoch + 1]);
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
  expect(await name("Bar")).toBe("Bar");
});
