import { afterEach, expect, test } from "bun:test";
import { createServer, type Server as SocketServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as watch from "./watch";
import * as agentSections from "./agent_sections";
import * as mirror from "./mirror";
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
          socket.write(JSON.stringify({ ...this.reply(request), request_id: request.request_id }) + "\n");
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
/** Runs `watch.run` against `path`, collecting its lines. */
function watching(path: string) {
  const lines: any[] = [];
  let failed: unknown = null;
  watch
    .run(path, line => lines.push(JSON.parse(line)), { grace_ms: 200, poll_ms: 50 })
    .catch(error => {
      failed = error;
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
