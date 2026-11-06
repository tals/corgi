import { Runtime } from "./mirror";
import { transport } from "./fixtures/transport";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { Cache, metadata } from "./machine_cache";
import * as sidebar from "./sidebar";

test("workspace display caches survive reopening with private permissions and profile isolation", () => {
  const dir = mkdtempSync("/tmp/corgi-cache-");
  const profile = { name: "work", target: "host", executable: "/corgi", socket: "/socket", home: "/home" };
  try {
    const cache = new Cache(profile, "local", dir + "/private");
    const row = sidebar.workspaceEntry({ id: 1, name: "project", cwd: "/project", active: true, working: 2 });
    Object.assign(row.resources, { known: true, cpu: 12, memory: 9007199254740993n });
    cache.write({ instance: "daemon-a", updated: 123, workspaces: [row] }, 2000);
    const reopened = new Cache(profile, "local", dir + "/private");
    expect(reopened.read()?.workspaces[0].resources.memory).toBe(9007199254740993n);
    expect(reopened.read()?.workspaces[0].working).toBe(2);
    expect(reopened.read()?.instance).toBe("daemon-a");
    expect(statSync(cache.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir + "/private").mode & 0o777).toBe(0o700);
    for (const key of ["target", "socket", "executable", "home", "name"] as const)
      expect(new Cache({ ...profile, [key]: "changed" }, "local", dir + "/private").read()).toBeNull();
    for (const corrupt of ["{", '{"version":2}', '{"version":1,"workspaces":[{}]}']) {
      writeFileSync(cache.path, corrupt);
      expect(reopened.read()).toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cached metadata restores tabs and splits before any terminal surface, and rejects broken layouts", () => {
  const dir = mkdtempSync("/tmp/corgi-layout-cache-");
  const runtime = new Runtime(),
    restored = new Runtime();
  const conn = transport(async () => {
    throw Error("UnexpectedRequest");
  });
  try {
    runtime.receive(conn, {
      workspaces: [
        {
          id: 4,
          name: "project",
          cwd: "/project",
          model: {
            nodes: [{ pane: 1 }, { pane: 2 }, { split: { axis: "horizontal", first: 0, second: 1, ratio: 500 } }],
            tabs: [{ id: 7, title: "editor", root: 2 }],
            revision: 9,
          },
        },
      ],
      panes: [
        { id: 1, name: "shell", cwd: "/project" },
        { id: 2, name: "editor", cwd: "/project" },
      ],
    });
    const cache = new Cache(null, "metadata-test", dir);
    cache.write({ instance: "daemon-a", updated: 123, workspaces: [], metadata: metadata(runtime) }, 2000);
    const cached = cache.read()!;
    restored.receive(conn, cached.metadata);
    expect(restored.workspaces.items[0].model.toJSON()).toEqual(runtime.workspaces.items[0].model.toJSON());
    expect(restored.panes.map(p => p.label)).toEqual(["shell", "editor"]);
    expect(restored.panes.every(p => p.terminal.known === null)).toBe(true);
    const bad = JSON.parse(readFileSync(cache.path, "utf8"));
    bad.metadata.workspaces[0].model.nodes[2].split.first = 2;
    writeFileSync(cache.path, JSON.stringify(bad));
    expect(cache.read()).toBeNull();
  } finally {
    runtime.destroy();
    restored.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
