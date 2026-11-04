import { test, expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WantedEffort, advance } from "./agent_effort";
import { Launch, Pane, Runtime } from "./runtime";
import { Text } from "./providers";
import { Terminal } from "./pane/terminal";
import { Workspace } from "./workspace";
import * as checkpoint from "./persist/checkpoint";
import * as json from "./json";
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
const titled = '[tui]\nterminal_title = ["app-name", "thread-id"]\n';
test("Codex panes Corgi starts leave their launcher's effort to the shared server", () => {
  const home = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    off = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    untitled = mkdtempSync(tmpdir() + "/corgi-ts-effort-"),
    high = 'model_reasoning_effort="high"',
    launch = (account: string, flags = "") =>
      Launch.in("codex", account, false, { flags, env: [], model: "gpt-5", effort: "high" });
  writeFileSync(home + "/config.toml", titled);
  writeFileSync(off + "/config.toml", "[features]\ndaemon_auto_start = false\n" + titled);
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
    // Without Corgi's integration nothing names the pane's thread, so the effort stays a flag.
    expect(launch(untitled).run("/bin/corgi")).toMatchObject({
      command: `'/bin/corgi' agent codex --model gpt-5 -c '${high}'`,
      effort: null,
    });
    // At the launcher's default effort, nothing sets one, on the command or later.
    for (const account of [home, off, untitled])
      expect(Launch.in("codex", account, false, { flags: "", env: [], model: "gpt-5" }).run("/bin/corgi")).toEqual({
        command: "'/bin/corgi' agent codex --model gpt-5",
        interactive_command: false,
        env: [["CODEX_HOME", account]],
        effort: null,
      });
  } finally {
    for (const dir of [home, off, untitled]) rmSync(dir, { recursive: true, force: true });
  }
  expect(Launch.in("claude", "", false, { flags: "", env: [], effort: "high" }).run("/bin/corgi").effort).toBeNull();
  expect(new Launch(undefined, "codex").run("/bin/corgi", ["resume", "abc"])).toEqual({
    command: "codex resume abc",
    interactive_command: true,
    env: [],
  });
});
test("a live reload keeps the effort a pane's agent runs without, and where it set it", async () => {
  const one = "01a19d30-c663-7862-a13b-3df431ee1507";
  using original = new Runtime();
  const ws = new Workspace(1, "/tmp");
  original.workspaces.items.push(ws);
  original.workspaces.next_id = 2;
  const [wanting, plain] = [0, 1].map(() => {
    const pane = new Pane(ws.model.newTab(""), Terminal.create(20, 4), "/tmp");
    pane.dormant = true;
    original.panes.push(pane);
    return pane;
  });
  original.workspaces.next_pane_id = ws.model.next_id;
  const wanted = new WantedEffort(wanting.id, wanting.terminal, "high");
  wanted.done.add(one);
  original.wanted_efforts.push(wanted);
  for (const live of [true, false]) {
    using next = new Runtime();
    const saved = json.parse(json.stringify(checkpoint.capture(original, live)));
    // A pane left at the launcher's default effort saves none.
    expect(saved.panes.map((p: any) => p.effort)).toEqual([live ? { value: "high", done: [one] } : null, null]);
    await checkpoint.restore(next, saved, live, "/tmp/unused-checkpoint.sock", "/tmp/corgi");
    // A cold start resumes the agent, and the launch sets its effort again.
    if (!live) expect(next.wanted_efforts).toEqual([]);
    else {
      expect(next.wanted_efforts).toHaveLength(1);
      const [kept] = next.wanted_efforts;
      expect([kept.pane, kept.effort, [...kept.done]]).toEqual([wanting.id, "high", [one]]);
      expect(kept.terminal).toBe(next.pane(wanting.id)!.terminal);
      expect(next.pane(plain.id)).toBeDefined();
    }
  }
});
