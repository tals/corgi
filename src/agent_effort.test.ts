import { test, expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WantedEffort, advance } from "./agent_effort";
import { Launch, type Runtime } from "./runtime";
import { Text } from "./providers";
import type { Terminal } from "./pane/terminal";
async function settled(wanted: WantedEffort) {
  while (wanted.busy) await Bun.sleep(2);
}
test("a launch's effort reaches each conversation its agent shows, once it runs on the shared server", async () => {
  const account = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    one = "01a19d30-c663-7862-a13b-3df431ee1507",
    two = "01a19d31-0000-7000-8000-000000000000",
    three = "01a19d32-0000-7000-8000-000000000000",
    updates: unknown[] = [];
  mkdirSync(account + "/app-server-control");
  const loaded = new Set<string>();
  const server = Bun.serve({
    unix: account + "/app-server-control/app-server-control.sock",
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("bad", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const value = JSON.parse(String(message));
        if (!value.id) return;
        if (value.method === "thread/settings/update") updates.push(value.params);
        const type = loaded.has(value.params?.threadId) ? "idle" : "notLoaded";
        ws.send(
          JSON.stringify({
            id: value.id,
            result:
              value.method === "thread/loaded/list"
                ? { data: [...loaded], nextCursor: null }
                : { thread: { status: { type } } },
          }),
        );
      },
    },
  });
  // A new conversation shows in the title, cut short, before the agent reports it.
  let title = `codex | ${one.slice(0, 29)}... | corgi`;
  const terminal = { exited: false, titleInfo: () => ({ text: title, pid: 7, revision: 1n }) } as unknown as Terminal,
    agent = { provider: "codex", session: new Text() },
    pane = {
      terminal,
      detection: { pid: 7 },
      launch: new Launch({ provider: "codex" }),
      agent: () => ({ ...agent, sessionId: () => agent.session.text() }),
      account: () => account,
    },
    wanted = new WantedEffort(1, terminal, "low"),
    runtime = { wanted_efforts: [wanted], pane: (id: number) => (id === 1 ? pane : null) } as unknown as Runtime;
  const step = async (now: number) => {
    advance(runtime, now);
    await settled(wanted);
  };
  try {
    await step(0);
    expect(updates).toEqual([]);
    loaded.add(one);
    await step(WantedEffort.retry_ms - 1);
    expect(updates).toEqual([]);
    await step(WantedEffort.retry_ms);
    expect(updates).toEqual([{ threadId: one, effort: "low" }]);
    agent.session = new Text(one);
    title = "";
    await step(2 * WantedEffort.retry_ms);
    expect(updates).toHaveLength(1);
    // A conversation the agent opens later gets it too.
    agent.session = new Text(two);
    loaded.add(two);
    await step(3 * WantedEffort.retry_ms);
    expect(updates).toEqual([
      { threadId: one, effort: "low" },
      { threadId: two, effort: "low" },
    ]);
    // One that never reaches the shared server is given up on, in server.log.
    agent.session = new Text(three);
    await step(4 * WantedEffort.retry_ms);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await step(4 * WantedEffort.retry_ms + WantedEffort.wait_ms + 1);
      expect(warn.mock.calls).toEqual([[`setting an agent's effort: ${three} never ran on codex's shared server`]]);
    } finally {
      warn.mockRestore();
    }
    expect(wanted.done.has(three)).toBe(true);
    expect(updates).toHaveLength(2);
    terminal.exited = true;
    await step(6 * WantedEffort.retry_ms + WantedEffort.wait_ms);
    expect(runtime.wanted_efforts).toEqual([]);
  } finally {
    server.stop(true);
    rmSync(account, { recursive: true, force: true });
  }
});
test("Codex panes Corgi starts leave their launcher's effort to the shared server", () => {
  const home = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    off = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    high = 'model_reasoning_effort="high"',
    launch = (account: string, flags = "") =>
      Launch.in("codex", account, false, { flags, env: [], model: "gpt-5", effort: "high" });
  writeFileSync(off + "/config.toml", "[features]\ndaemon_auto_start = false\n");
  try {
    const deferred = launch(home);
    expect(deferred.run("/bin/corgi", ["resume", "abc"])).toMatchObject({
      command: "'/bin/corgi' agent codex --model gpt-5 resume abc",
      effort: "high",
    });
    // Saved and restored, it still knows the effort is the launcher's.
    expect(Launch.from(JSON.parse(JSON.stringify(deferred))).run("/bin/corgi").effort).toBe("high");
    // Typed into a shell, as a woken pane offers it, the command keeps its effort.
    expect(deferred.typed(["resume", "abc"])).toBe(`codex --model gpt-5 -c '${high}' resume abc`);
    // Any `-c` someone wrote keeps Codex off the shared server, so the effort stays a flag too.
    expect(launch(home, "-c model_verbosity=high").run("/bin/corgi")).toMatchObject({
      command: `'/bin/corgi' agent codex --model gpt-5 -c model_verbosity=high -c '${high}'`,
      effort: null,
    });
    const written = new Launch({ provider: "codex", args: ["-c", high], env: [["CODEX_HOME", home]] });
    expect(written.run("/bin/corgi")).toMatchObject({ command: `'/bin/corgi' agent codex -c '${high}'`, effort: null });
    // So do other options that need Codex's own server, an account whose Codex won't start
    // the shared server, and an agent that already runs.
    expect(launch(home, "--search").run("/bin/corgi").effort).toBeNull();
    expect(launch(off).run("/bin/corgi")).toMatchObject({
      command: `'/bin/corgi' agent codex --model gpt-5 -c '${high}'`,
      effort: null,
    });
    expect(deferred.run("/bin/corgi", null, null, "codex attach")).toMatchObject({
      command: "'/bin/corgi' agent codex attach",
      effort: null,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(off, { recursive: true, force: true });
  }
  expect(Launch.in("claude", "", false, { flags: "", env: [], effort: "high" }).run("/bin/corgi").effort).toBeNull();
  expect(new Launch(undefined, "codex").run("/bin/corgi", ["resume", "abc"])).toEqual({
    command: "codex resume abc",
    interactive_command: true,
    env: [],
  });
});
