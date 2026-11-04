import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deferred, reachable, settle } from "./daemon_effort";
import { adapter } from "./index";
const xhigh = 'model_reasoning_effort="xhigh"';
test("an effort override comes off where the rest keeps Codex on its shared server", () => {
  expect(deferred(["-c", xhigh])).toEqual({ args: [], effort: "xhigh" });
  expect(
    deferred([
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5",
      "-c",
      xhigh,
      "fork",
      "01a19d19-c0b9-7371-813d-63a71adf5bd3",
      "--cd",
      "/work",
    ]),
  ).toEqual({
    args: [
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5",
      "fork",
      "01a19d19-c0b9-7371-813d-63a71adf5bd3",
      "--cd",
      "/work",
    ],
    effort: "xhigh",
  });
  expect(deferred(["--yolo", "-s", "workspace-write", "-a", "never", "-C", "/tmp", "-c", xhigh])?.args).toEqual([
    "--yolo",
    "-s",
    "workspace-write",
    "-a",
    "never",
    "-C",
    "/tmp",
  ]);
  expect(deferred(["--config=model_reasoning_effort=low", "--model=gpt-5"])).toEqual({
    args: ["--model=gpt-5"],
    effort: "low",
  });
  expect(deferred(["-cmodel_reasoning_effort='high'", "resume", "abc"])).toEqual({
    args: ["resume", "abc"],
    effort: "high",
  });
});
test("the override stays when anything else needs Codex's own server", () => {
  for (const args of [
    [],
    ["--model", "gpt-5"],
    ["-c", xhigh, "--search"],
    ["-c", xhigh, "-c", "model_verbosity=high"],
    ["-c", xhigh, "--enable", "web_search"],
    ["-c", xhigh, "--no-daemon"],
    ["-c", xhigh, "--profile", "work"],
    ["-c", xhigh, "write the tests"],
    ["-c", xhigh, "--", "write the tests"],
    ["-c", xhigh, "resume", "--last"],
    ["-c", xhigh, "--model"],
    ["-c", 'model_reasoning_effort="extreme"'],
    ["-c"],
  ])
    expect(deferred(args)).toBeNull();
});
test("Codex keeps the effort on a command Corgi doesn't start itself", () => {
  // `corgi agent codex` and the pane's `codex` exec through `prepare`, with no one to set the effort later.
  expect(adapter.launch.prepare).toBeUndefined();
});
test("the override stays where Corgi can't name the thread a pane shows on the shared server", () => {
  const home = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    titled = '[tui]\nterminal_title = ["app-name", "thread-id"]\n',
    write = (text: string) => writeFileSync(home + "/config.toml", text);
  try {
    // Without Corgi's integration, Codex's title doesn't name its thread.
    expect(reachable(home)).toBe(false);
    write('model = "gpt-5"\n');
    expect(reachable(home)).toBe(false);
    write('[tui]\nterminal_title = ["app-name", "project"]\n');
    expect(reachable(home)).toBe(false);
    expect(adapter.launch.deferred?.(["-c", xhigh], home)).toBeNull();
    write(titled);
    expect(reachable(home)).toBe(true);
    expect(adapter.launch.deferred?.(["-c", xhigh], home)).toEqual({ args: [], effort: "xhigh" });
    // Codex starts the shared server unless its config says not to.
    write("[features]\ndaemon_auto_start = true\n" + titled);
    expect(reachable(home)).toBe(true);
    write("[features]\ndaemon_auto_start = false\n" + titled);
    expect(reachable(home)).toBe(false);
    expect(adapter.launch.deferred?.(["-c", xhigh], home)).toBeNull();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("the effort is set once the shared server runs the thread its title names", async () => {
  const dir = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    path = dir + "/control.sock",
    [one, two, three] = ["01a19d30-c663-7862-a13b-3df431ee1507", "01a19d31", "01a19d32"].map(id =>
      id.length === 36 ? id : id + "-0000-7000-8000-000000000000",
    ),
    updates: unknown[] = [],
    threads = new Map([[one, { status: "notLoaded", effort: "medium" }]]);
  let loaded = [one, two];
  const server = Bun.serve({
    unix: path,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("bad", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const value = JSON.parse(String(message)),
          thread = threads.get(value.params?.threadId);
        if (!value.id) return;
        if (value.method === "thread/settings/update") {
          updates.push(value.params);
          thread!.effort = value.params.effort;
        }
        const reply =
          value.method === "thread/loaded/list"
            ? { result: { data: loaded, nextCursor: null } }
            : value.method !== "thread/read"
              ? { result: {} }
              : thread
                ? { result: { thread: { status: { type: thread.status }, reasoningEffort: thread.effort } } }
                : { error: { code: -32600, message: "no thread" } };
        ws.send(JSON.stringify({ id: value.id, ...reply }));
      },
    },
  });
  try {
    expect(await settle(path, one, "low")).toBeNull();
    expect(await settle(path, two.slice(0, 29), "low")).toBeNull();
    expect(updates).toEqual([]);
    threads.get(one)!.status = "idle";
    expect(await settle(path, one.slice(0, 29), "low")).toEqual({ session: one });
    expect(await settle(path, one, "high")).toEqual({ session: one });
    expect(updates).toEqual([
      { threadId: one, effort: "low" },
      { threadId: one, effort: "high" },
    ]);
    loaded = [one, one.slice(0, 29) + "0000000"];
    expect(await settle(path, one.slice(0, 29), "low")).toBeNull();
    expect(await settle(dir + "/missing.sock", one, "low")).toBeNull();
    // A thread opened later gets it while the one set before keeps it, but
    // not once someone changed that one's, or it can't be read any more.
    threads.set(two, { status: "idle", effort: "medium" });
    expect(await settle(path, two, "high", one)).toEqual({ session: two });
    threads.set(three, { status: "idle", effort: "low" });
    threads.get(two)!.effort = "low";
    expect(await settle(path, three, "high", two)).toBe("changed");
    expect(await settle(path, three, "high", "01a19d33-0000-7000-8000-000000000000")).toBe("changed");
    expect(updates).toHaveLength(3);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
