import { test, expect } from "bun:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { Codex } from "./providers/codex";
import { Text } from "./providers/common";
import { childName, unique, threadState, location, snapshot, Worker } from "./codex_observer";

test("title UUID parsing handles truncation and refuses ambiguity", () => {
  const id = "01901234-1234-1234-1234-123456789abc";
  expect(Codex.titleSession("codex | " + id + " | Ready")?.text()).toBe(id);
  expect(Codex.titleSession("codex | 01901234-1234-1234-1234-12345...")?.text()).toBe(id.slice(0, 29));
  expect(Codex.titleSession("project 01901234")).toBeNull();
  expect(Codex.titleSession(id + " " + id)).toBeNull();
  const prefix = Codex.titleSession("01901234-1234-1234-1234-12345...")!;
  expect(unique([id, "01901234-1234-1234-1234-123456789def"], prefix)).toBeNull();
});

test("unloaded child threads read as idle", () => {
  for (const [value, state] of [
    [{ type: "notLoaded" }, "idle"],
    [{ type: "systemError" }, "idle"],
    [{ type: "idle" }, "idle"],
    [{ type: "active", activeFlags: [] }, "working"],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "blocked"],
    [{ type: "future" }, "unknown"],
  ] as const)
    expect(threadState(value)).toBe(state);
});

test("child threads are named by their task, then nickname", () => {
  const spawned = (agent_path: string | null) => ({
    name: null,
    agentNickname: "Boole",
    source: { subAgent: { thread_spawn: { depth: 1, agent_path, agent_nickname: "Boole", agent_role: null } } },
  });
  expect(childName(spawned("/root/typed_rpc"))).toBe("typed_rpc");
  expect(childName(spawned("/root/typed_rpc/tests"))).toBe("typed_rpc/tests");
  expect(childName(spawned(null))).toBe("Boole");
  expect(childName({ ...spawned("/root/typed_rpc"), name: "Renamed" })).toBe("Renamed");
});

function itemPages(...data: unknown[][]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      const at = Number(params.cursor ?? 0);
      return { result: { data: data[at], nextCursor: at + 1 < data.length ? String(at + 1) : null } };
    },
  };
}
const change = (turnId: string, ...paths: string[]) => ({
  turnId,
  item: { type: "fileChange", status: "completed", changes: paths.map(path => ({ path })) },
});
const command = (turnId: string, cwd: string) => ({
  turnId,
  item: { type: "commandExecution", status: "completed", cwd },
});
test("location recovers edits across item pages and turns, newest successful edit first", async () => {
  const client = itemPages(
    [
      { turnId: "new", item: { type: "userMessage" } },
      { ...change("new", "/repo/failed"), item: { ...change("new", "/repo/failed").item, status: "failed" } },
    ],
    [change("old", "/repo/.worktrees/one/a", "/repo/.worktrees/two/b"), change("old", "/repo/older")],
  );
  expect(await location(client, "session", "/repo")).toEqual({
    cwd: "/repo",
    writes: ["/repo/.worktrees/one/a", "/repo/.worktrees/two/b"],
    ran: [],
    basis: "default",
  });
  expect(client.calls.map(c => c.params.cursor)).toEqual([null, "1"]);
  for (const call of client.calls) {
    expect(call.method).toBe("thread/items/list");
    expect(call.params).toMatchObject({ threadId: "session", sortDirection: "desc", limit: 100 });
    expect(call.params.turnId).toBeUndefined();
  }
});
test("edits take precedence over later read commands in the same turn", async () => {
  const client = itemPages(
    [command("new", "/repo")],
    [change("new", "/repo/.worktrees/one/file"), change("new", "/repo/older")],
  );
  expect(await location(client, "session", "/repo")).toEqual({
    cwd: "/repo",
    writes: ["/repo/.worktrees/one/file"],
    ran: ["/repo"],
    basis: "default",
  });
});
test("a newer turn's latest command moves location before an edit", async () => {
  const client = itemPages(
    [command("new", "/repo/.worktrees/two"), command("new", "/repo")],
    [change("old", "/repo/.worktrees/one/file")],
  );
  expect(await location(client, "session", "/repo")).toEqual({
    cwd: "/repo/.worktrees/two",
    writes: [],
    ran: ["/repo/.worktrees/two", "/repo"],
    basis: "named",
  });
});
test("commands in the thread's own folder don't move location off a directory the turn chose", async () => {
  const client = itemPages([
    command("new", "/repo"),
    command("new", "/repo/.worktrees/one"),
    command("new", "/repo/"),
    command("old", "/repo/.worktrees/two"),
  ]);
  expect(await location(client, "session", "/repo")).toEqual({
    cwd: "/repo/.worktrees/one",
    writes: [],
    ran: ["/repo", "/repo/.worktrees/one", "/repo/"],
    basis: "named",
  });
  expect(
    await location(itemPages([command("new", "/repo"), command("old", "/repo/.worktrees/two")]), "session", "/repo"),
  ).toEqual({
    cwd: "/repo",
    writes: [],
    ran: ["/repo"],
    basis: "default",
  });
});
test("a turn without location evidence retains the previous command directory", async () => {
  const client = itemPages([{ turnId: "new", item: { type: "userMessage" } }, command("old", "/repo/.worktrees/one")]);
  expect(await location(client, "session", "/repo")).toEqual({
    cwd: "/repo/.worktrees/one",
    writes: [],
    ran: ["/repo/.worktrees/one"],
    basis: "named",
  });
  expect(await location(itemPages([]), "session", "/repo")).toBeNull();
});
test("a partial location scan fails instead of publishing an unverified command fallback", async () => {
  const client = itemPages([command("new", "/repo/.worktrees/two")]);
  const call = client.call.bind(client);
  client.call = async (method, params) => {
    if (params.cursor) throw Error("Disconnected");
    const result = await call(method, params);
    result.result.nextCursor = "1";
    return result;
  };
  await expect(location(client, "session", "/repo")).rejects.toThrow("Disconnected");
});
test("location history scans have a page bound", async () => {
  const client = itemPages(...Array.from({ length: 33 }, () => []));
  await expect(location(client, "session", "/repo")).rejects.toThrow("TooManyItems");
  expect(client.calls.length).toBe(32);
});
test("an ephemeral thread reads as one without listing its turns", async () => {
  const methods: string[] = [];
  const client = {
    async call(method: string) {
      methods.push(method);
      return { result: { thread: { id: "fork", ephemeral: true, status: { type: "active", activeFlags: [] } } } };
    },
  };
  const request = { pane: 1, pid: 42, prefix: new Text("fork"), actor: 0, generation: 1n, title_revision: 1n };
  const out = await snapshot(client as any, request, "fork");
  expect(out).toMatchObject({ ephemeral: true, state: "working" });
  expect(methods).toEqual(["thread/read"]);
});
test("with no Codex daemon to ask, pane requests are missed and conversation requests wait", async () => {
  const worker = new Worker();
  worker.socket = path.join(tmpdir(), `corgi-no-codex-${process.pid}.sock`);
  const pane = { pane: 1, pid: 42, prefix: new Text("11111111"), actor: 0, generation: 1n, title_revision: 1n };
  worker.requests = [pane, { ...pane, pane: 0, pid: 0, actor: 7 }];
  await worker.run();
  expect(worker.takeMissed()).toEqual([pane]);
  expect(worker.take()).toEqual([]);
});
