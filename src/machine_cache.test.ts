import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { Cache } from "./machine_cache";
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
