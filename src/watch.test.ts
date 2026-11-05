import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createServer, type Server as SocketServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as watch from "./watch";
import * as agentSections from "./agent_sections";
import * as mirror from "./mirror";
import * as sidebar from "./sidebar";
import * as subagentTooltip from "./subagent_tooltip";
import * as json from "./json";
import * as protocol from "./protocol";
import { Runtime, Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { Text, type Agent as DaemonAgent } from "./agents";
import { snapshot } from "./session";
import { Controller } from "./controller";
import { transport } from "./fixtures/transport";

/** A daemon with two workspaces: three agents and a shell in "api", none in "docs". */
function daemon() {
  const r = new Runtime(),
    api = new Workspace(1, "/tmp", "api"),
    docs = new Workspace(2, "/tmp", "docs");
  r.workspaces.items = [api, docs];
  const open = (fields: Partial<DaemonAgent> = {}, name = "", activity = "") => {
    api.model.next_id = r.workspaces.next_pane_id;
    const id = api.model.newTab("");
    r.workspaces.next_pane_id = api.model.next_id;
    const p = new Pane(id, Terminal.create(20, 4), "/tmp");
    r.panes.push(p);
    Object.assign(p.agent(), fields, { name: new Text(name) });
    if (activity) p.agent().activity = new Text(activity);
    return p;
  };
  const working = open({ provider: "claude", state: "working" }, "Fix the login redirect", "Reading auth.ts"),
    blocked = open({ provider: "codex", state: "blocked", attention: "needs_input" }),
    ready = open({ provider: "claude", state: "idle", attention: "finished" }, "Write\x1b the docs"),
    shell = open();
  ready.agent().observation.completed = 1n;
  return { r, api, working, blocked, ready, shell };
}
/** What a client reads off the wire, normalized. */
function received(value: unknown) {
  const runtime = new mirror.Runtime();
  runtime.receive(
    transport(async () => ({})),
    json.parse(json.stringify(value)),
  );
  return runtime;
}

test("the summary lists each workspace's agents as the sidebar sorted by activity does", () => {
  const { r, api, working, blocked, ready } = daemon();
  try {
    const wire: any = json.parse(json.stringify(snapshot(r)));
    // The hand-sorted order doesn't matter; the star does.
    wire.workspaces[0].agent_order = [{ pane: ready.id }, { pane: working.id }];
    wire.workspaces[0].pinned_agents = [{ pane: blocked.id }];
    wire.headless_sessions = [
      {
        id: 7,
        workspace: api.id,
        provider: "codex",
        session: "s",
        state: "idle",
        attention: "none",
        observation: { completed: 2, read: 2 },
        agent: { provider: "codex", name: "Review the PR", state: "idle" },
      },
    ];
    const runtime = received(wire);
    expect(watch.summary(runtime)).toEqual({
      running: true,
      counts: { agents: 4, working: 2, needs_input: 1, ready: 1, idle: 1, done: 0, unread: 1 },
      workspaces: [
        {
          id: 1,
          name: "api",
          links: [],
          pointer: "",
          agents: [
            {
              pane: blocked.id,
              headless: null,
              title: "Codex",
              provider: "codex",
              starred: true,
              section: "working",
              needs_input: true,
              unread: false,
              status: "needs_input",
              detail: "Needs input",
              glyph: "none",
              corgi: "content",
              compacting_since: 0,
              retry_at: 0,
            },
            {
              pane: working.id,
              headless: null,
              title: "Fix the login redirect",
              provider: "claude",
              starred: false,
              section: "working",
              needs_input: false,
              unread: false,
              status: "working",
              detail: "Reading auth.ts",
              glyph: "thinking",
              corgi: "content",
              compacting_since: 0,
              retry_at: 0,
            },
            {
              pane: ready.id,
              headless: null,
              title: "Write? the docs",
              provider: "claude",
              starred: false,
              section: "ready",
              needs_input: false,
              unread: true,
              status: "ready",
              detail: "",
              glyph: "none",
              corgi: "asleep",
              compacting_since: 0,
              retry_at: 0,
            },
            {
              pane: null,
              headless: 7,
              title: "Review the PR",
              provider: "codex",
              starred: false,
              section: "idle",
              needs_input: false,
              unread: false,
              status: "idle",
              detail: "",
              glyph: "none",
              corgi: "asleep",
              compacting_since: 0,
              retry_at: 0,
            },
          ],
        },
        { id: 2, name: "docs", links: [], pointer: "", agents: [] },
      ],
    });
    // The viewer's own list, sorted by activity, agrees.
    const viewer: any = new Controller({ socket: "", request: transport(async () => ({})).request });
    try {
      viewer.receiveSnapshot(wire);
      viewer.prefs.agent_sort = "activity";
      expect(
        viewer
          .agentEntries()
          .filter((e: any) => "pane" in e.target || "headless" in e.target)
          .map((e: any) => e.target),
      ).toEqual([{ pane: blocked.id }, { pane: working.id }, { pane: ready.id }, { headless: 7 }]);
    } finally {
      viewer.runtime.destroy();
    }
    runtime.destroy();
  } finally {
    r.destroy();
  }
});

test("watch and the sidebar list only Corgi chats held by a live pane", () => {
  const { r, shell } = daemon(),
    viewer = new Controller(transport(async () => ({ viewers: [] })));
  let runtime: mirror.Runtime | undefined;
  try {
    const wire = {
      ...snapshot(r),
      headless_sessions: [
        { id: 7, pane: shell.id, exited: false },
        { id: 8, pane: null, exited: false },
        { id: 9, pane: shell.id, exited: true },
      ].map(s => ({ ...s, corgi: true, workspace: 1, provider: "claude", state: "idle", session: `s${s.id}` })),
    };
    runtime = received(wire);
    viewer.receiveSnapshot(wire);
    const summary = watch.summary(runtime);
    if (!summary.running) throw Error("not running");
    expect(summary.workspaces[0].agents.filter(a => a.headless !== null).map(a => [a.headless, a.title])).toEqual([
      [7, "Corgi"],
    ]);
    expect(
      viewer
        .agentEntries()
        .filter(e => "headless" in e.target)
        .map(e => [e.target, e.name]),
    ).toEqual([[{ headless: 7 }, "Corgi"]]);
  } finally {
    runtime?.destroy();
    viewer.runtime.destroy();
    r.destroy();
  }
});

test("watch and the sidebar suppress stale child claims for pane and headless agents", () => {
  const now_ms = Date.now(),
    now = now_ms * 1000,
    agent = {
      conversation: 1,
      provider: "codex",
      state: "working",
      attention: "none",
      activity: "Reading source",
      subagents: { running: 1, blocked: 0, waiting: true },
    },
    wire = {
      ...session("api", agent),
      conversations: [
        { id: 1, children_observed_at: now, observed_at: now, agent },
        { id: 2, parent: 1, observed_at: now, agent: { provider: "codex", state: "working" } },
      ],
      headless_sessions: [{ id: 7, workspace: 1, provider: "codex", state: "working", agent }],
    },
    conn = transport(async () => ({})),
    runtime = new mirror.Runtime(),
    viewer = new Controller(conn);
  try {
    for (const stamp of [now, now - subagentTooltip.fresh_window - 1, 0, now]) {
      wire.conversations[0].children_observed_at = stamp;
      runtime.receive(conn, wire);
      viewer.receiveSnapshot(wire);
      const summary = watch.summary(runtime, 1, new agentSections.Since(), now_ms);
      if (!summary.running) throw Error("not running");
      const agents = summary.workspaces[0].agents,
        rows = viewer.agentEntries().filter(e => sidebar.isAgent(e.target)),
        expected = {
          detail: stamp === now ? "Waiting on agents" : "Reading source",
          glyph: stamp === now ? "waiting" : "thinking",
          corgi: "content",
        } as const;
      expect(agents).toHaveLength(2);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const shown = {
          detail: sidebar.rowDetail(row),
          glyph: sidebar.activityKind(row, 1),
          corgi: sidebar.corgiMode(row, 1),
        };
        expect(shown).toEqual(expected);
        expect(agents.find(a => ("pane" in row.target ? a.pane === row.target.pane : a.headless === 7))).toMatchObject(
          shown,
        );
      }
      expect(runtime.panes[0].agent.subagents.waiting).toBe(true);
    }
  } finally {
    viewer.runtime.destroy();
    runtime.destroy();
  }
});

test("the agent that entered a section last is listed first in it, from one summary to the next", () => {
  const { r, working, ready } = daemon();
  try {
    const since = new agentSections.Since(),
      order = (now_ms: number) => {
        const runtime = received(snapshot(r)),
          s = watch.summary(runtime, 0, since, now_ms);
        runtime.destroy();
        if (!s.running) throw Error("not running");
        return s.workspaces[0].agents.filter(a => a.section === "ready").map(a => a.pane);
      };
    expect(order(1_000)).toEqual([ready.id]);
    // The working agent finishes later, so it heads the ready section.
    Object.assign(working.agent(), { state: "idle", attention: "finished" });
    expect(order(2_000)).toEqual([working.id, ready.id]);
  } finally {
    r.destroy();
  }
});

test("a new agent waiting for its first prompt counts as working, as the daemon holds it", () => {
  const { r, working } = daemon();
  try {
    working.agent().state = "idle";
    const runtime = received(snapshot(r)),
      s = watch.summary(runtime);
    if (!s.running) throw Error("not running");
    expect(s.workspaces[0].agents.find(a => a.pane === working.id)).toMatchObject({ section: "working" });
    runtime.destroy();
  } finally {
    r.destroy();
  }
});

test("a done agent no longer needs input", () => {
  const { r, blocked } = daemon();
  try {
    blocked.agent().state = "done";
    const s = watch.summary(received(snapshot(r)));
    if (!s.running) throw Error("not running");
    expect(s.workspaces[0].agents.find(a => a.pane === blocked.id)).toMatchObject({
      section: "done",
      needs_input: false,
    });
    expect(s.counts).toMatchObject({ working: 1, done: 1, needs_input: 0 });
  } finally {
    r.destroy();
  }
});

test("a retrying agent says so and leaves its countdown to retry_at", () => {
  const { r, working } = daemon();
  try {
    const wire: any = json.parse(json.stringify(snapshot(r)));
    wire.panes.find((p: any) => p.id === working.id).agent.retry_at = 1_900_000_000_000;
    const s = watch.summary(received(wire));
    if (!s.running) throw Error("not running");
    expect(s.workspaces[0].agents.find(a => a.pane === working.id)).toMatchObject({
      section: "working",
      status: "retrying",
      detail: "Retrying…",
      glyph: "waiting",
      retry_at: 1_900_000_000_000,
    });
  } finally {
    r.destroy();
  }
});

test("archived workspaces and their agents stay out, as in the sidebar", () => {
  const { r, api } = daemon();
  try {
    api.archived = true;
    const s = watch.summary(received(snapshot(r)));
    if (!s.running) throw Error("not running");
    expect(s.workspaces.map(ws => ws.name)).toEqual(["docs"]);
    expect(s.counts.agents).toBe(0);
  } finally {
    r.destroy();
  }
});

test("the printer writes only summaries that changed", () => {
  const lines: string[] = [],
    printer = new watch.Printer(line => lines.push(line));
  printer.print({ running: false });
  printer.print({ running: false });
  const running: watch.Summary = {
    running: true,
    counts: { agents: 0, working: 0, needs_input: 0, ready: 0, idle: 0, done: 0, unread: 0 },
    workspaces: [{ id: 1, name: "api", links: [], pointer: "", agents: [] }],
  };
  printer.print(running);
  printer.print(structuredClone(running));
  printer.print({ running: false });
  expect(lines).toEqual([
    '{"running":false}\n',
    '{"running":true,"counts":{"agents":0,"working":0,"needs_input":0,"ready":0,"idle":0,"done":0,"unread":0},"workspaces":[{"id":1,"name":"api","links":[],"pointer":"","agents":[]}]}\n',
    '{"running":false}\n',
  ]);
});

/** A fake daemon that answers `session.subscribe` and pushes what the test sends. */
class FakeDaemon {
  server: SocketServer;
  clients: Socket[] = [];
  /** Pushes written in one piece with the next reply. */
  along: object[] = [];
  constructor(
    readonly path: string,
    public reply: (request: any) => object = () => session("api"),
  ) {
    this.server = createServer(socket => {
      this.clients.push(socket);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          const reply = { ...this.reply(request), request_id: request.request_id };
          socket.write([reply, ...this.along.splice(0)].map(v => JSON.stringify(v) + "\n").join(""));
        }
      });
      socket.on("error", () => {});
    });
  }
  listen(): Promise<void> {
    return new Promise(resolve => this.server.listen(this.path, resolve));
  }
  push(value: object): void {
    for (const c of this.clients) c.write(JSON.stringify(value) + "\n");
  }
  stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    this.clients = [];
    return new Promise(resolve => this.server.close(() => resolve()));
  }
}
/** A one-workspace snapshot as the daemon sends it; `name` names its workspace. */
function session(name: string, agent: object | null = null) {
  return {
    type: "session",
    protocol: protocol.version,
    workspaces: [
      { id: 1, name, cwd: "/tmp", model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 } },
    ],
    panes: [
      {
        id: 1,
        workspace: 1,
        tab: 1,
        cols: 80,
        rows: 24,
        name: "",
        agent: agent ?? { provider: null, state: "unknown", attention: "none", observation: { completed: 0, read: 0 } },
      },
    ],
    conversations: [],
    headless_sessions: [],
  };
}
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
/** Runs `watch.run` against `path` until the test ends, collecting its lines. */
function watching(path: string, intensity: () => number = () => 1) {
  const lines: any[] = [],
    stop = new AbortController();
  let failed: unknown = null;
  const running = watch
    .run(path, line => lines.push(JSON.parse(line)), { intensity, grace_ms: 200, poll_ms: 50, signal: stop.signal })
    .catch(error => {
      failed = error;
    });
  cleanup.push(() => {
    stop.abort();
    return running;
  });
  return {
    lines,
    failed: () => failed,
    async next(count: number) {
      for (let i = 0; i < 200 && lines.length < count && failed === null; i++) await Bun.sleep(10);
      if (failed !== null) throw failed;
      expect(lines.length).toBe(count);
      return lines[count - 1];
    },
  };
}
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-watch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("watching reports no daemon, then follows one that appears, its pushes and its going", async () => {
  const path = join(folder(), "control.sock"),
    w = watching(path);
  expect(await w.next(1)).toEqual({ running: false });
  const fake = new FakeDaemon(path);
  cleanup.push(() => fake.stop());
  await fake.listen();
  expect(await w.next(2)).toMatchObject({ running: true, workspaces: [{ name: "api", agents: [] }] });
  // Terminal output pushes the same agents again; only a change prints.
  fake.push(session("api"));
  fake.push(session("api", { provider: "claude", state: "working", attention: "none", name: "Fix it" }));
  expect(await w.next(3)).toMatchObject({
    counts: { agents: 1, working: 1 },
    workspaces: [{ agents: [{ pane: 1, title: "Fix it", section: "working" }] }],
  });
  await fake.stop();
  expect(await w.next(4)).toEqual({ running: false });
  await Bun.sleep(150);
  expect(w.lines.length).toBe(4);
});

test("watching pushes browser links and their labels, collapsing duplicate binds", async () => {
  const path = join(folder(), "control.sock"),
    fake = new FakeDaemon(path);
  cleanup.push(() => fake.stop());
  await fake.listen();
  const w = watching(path);
  expect(await w.next(1)).toMatchObject({ workspaces: [{ links: [] }] });
  const endpoint = {
    pid: 12,
    pane: 1,
    name: "web",
    transport: "tcp",
    bind_address: "127.0.0.1",
    port: 3000,
    ipv6: false,
    interfaces: [],
    scheme: "http",
    http_status: 200,
    label: "",
  };
  const push = (endpoints: object[]) => fake.push({ ...session("api"), ports: { workspaces: [{ id: 1, endpoints }] } });
  push([
    endpoint,
    { ...endpoint, bind_address: "::1", label: "API preview" },
    { ...endpoint, port: 5432, scheme: "unknown", http_status: null },
    { ...endpoint, port: 3001, http_status: 503 },
    { ...endpoint, port: 4000 },
  ]);
  expect(await w.next(2)).toMatchObject({
    workspaces: [
      {
        links: [
          { url: "http://localhost:3000", label: "API preview" },
          { url: "http://localhost:4000", label: "" },
        ],
        pointer: "Open Link ↗ 2",
      },
    ],
  });
  push([{ ...endpoint, label: "API docs" }]);
  expect(await w.next(3)).toMatchObject({
    workspaces: [{ links: [{ url: "http://localhost:3000", label: "API docs" }], pointer: "API docs ↗" }],
  });
  push([]);
  expect(await w.next(4)).toMatchObject({ workspaces: [{ links: [], pointer: "" }] });
});

test("a daemon that comes back within the grace period prints nothing in between", async () => {
  const path = join(folder(), "control.sock"),
    first = new FakeDaemon(path);
  await first.listen();
  const w = watching(path);
  expect(await w.next(1)).toMatchObject({ running: true });
  await first.stop();
  const second = new FakeDaemon(path);
  cleanup.push(() => second.stop());
  await second.listen();
  await Bun.sleep(400);
  expect(w.lines.length).toBe(1);
  second.push(session("renamed"));
  expect(await w.next(2)).toMatchObject({ running: true, workspaces: [{ name: "renamed" }] });
});

test("a push read along with the subscription's reply is shown after it", async () => {
  const path = join(folder(), "control.sock"),
    fake = new FakeDaemon(path);
  fake.along.push(session("renamed"));
  cleanup.push(() => fake.stop());
  await fake.listen();
  const w = watching(path);
  await w.next(2);
  expect(w.lines.map(line => line.workspaces[0].name)).toEqual(["api", "renamed"]);
});

test("a daemon that refuses the subscription ends the watch", async () => {
  const path = join(folder(), "control.sock"),
    fake = new FakeDaemon(path, () => ({ err: "UnsupportedProtocol" }));
  cleanup.push(() => fake.stop());
  await fake.listen();
  const w = watching(path);
  for (let i = 0; i < 100 && w.failed() === null; i++) await Bun.sleep(10);
  expect((w.failed() as Error).message).toBe("UnsupportedProtocol");
  expect(w.lines).toEqual([]);
});

test("a daemon that hangs up on the subscription gets the grace period before it counts as gone", async () => {
  const path = join(folder(), "control.sock"),
    server = createServer(socket => socket.destroy());
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.listen(path, resolve));
  const w = watching(path);
  await Bun.sleep(100);
  expect(w.lines).toEqual([]);
  expect(await w.next(1)).toEqual({ running: false });
});

test("a socket that can't be opened for another reason ends the watch", async () => {
  const w = watching(join(folder(), "x".repeat(300)));
  for (let i = 0; i < 100 && w.failed() === null; i++) await Bun.sleep(10);
  expect((w.failed() as any)?.code).toBe("EINVAL");
  expect(w.lines).toEqual([]);
});

test("stale child claims expire without a daemon push", async () => {
  const now_ms = 1_800_000_000_000;
  setSystemTime(new Date(now_ms));
  cleanup.push(() => setSystemTime());
  const path = join(folder(), "control.sock"),
    agent = {
      conversation: 1,
      provider: "codex",
      state: "working",
      attention: "none",
      activity: "Reading source",
      subagents: { running: 1, blocked: 0, waiting: true },
    },
    fake = new FakeDaemon(path, () => ({
      ...session("api", agent),
      conversations: [
        { id: 1, observed_at: now_ms * 1000, children_observed_at: now_ms * 1000, agent },
        { id: 2, parent: 1, observed_at: now_ms * 1000, agent: { provider: "codex", state: "working" } },
      ],
    }));
  cleanup.push(() => fake.stop());
  await fake.listen();
  const w = watching(path);
  expect(await w.next(1)).toMatchObject({
    workspaces: [{ agents: [{ detail: "Waiting on agents", glyph: "waiting" }] }],
  });
  setSystemTime(new Date(now_ms + subagentTooltip.fresh_window / 1000 + 1));
  expect(await w.next(2)).toMatchObject({
    workspaces: [{ agents: [{ detail: "Reading source", glyph: "thinking" }] }],
  });
});

test("a change to the corgi intensity shows without a daemon push", async () => {
  const path = join(folder(), "control.sock"),
    fake = new FakeDaemon(path, () =>
      session("api", { provider: "claude", state: "working", attention: "none", name: "Fix it" }),
    );
  cleanup.push(() => fake.stop());
  await fake.listen();
  let intensity = 1;
  const w = watching(path, () => intensity),
    before = await w.next(1);
  intensity = 0;
  const after = await w.next(2);
  expect(after.workspaces[0].agents[0].corgi).not.toBe(before.workspaces[0].agents[0].corgi);
});
