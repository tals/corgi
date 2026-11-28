import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { openSync, closeSync, mkdirSync, mkdtempSync, realpathSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as observers from "../../observer_service";
import { Terminal } from "../../pane/terminal";
import { Pane, Launch } from "../../runtime";
import { Server } from "../../server";
import { childrenAvailable, conversation } from "../../subagent_tooltip";
import { directory } from "./config";
import { database } from "./summaries";
import { Worker } from "./observer";
import { selected } from "./presence";

const first = "11111111-1111-4111-8111-111111111111",
  second = "22222222-2222-4222-8222-222222222222";
const supported = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

function fixture() {
  const account = realpathSync(mkdtempSync(join(tmpdir(), "corgi-agy-observer-"))),
    root = directory(account),
    presence = join(root, "presence"),
    server = new Server(join(account, "corgi.sock"), "corgi", "test"),
    terminal = new Terminal(80, 24),
    pane = new Pane(1, terminal, account),
    worker = new Worker(account);
  mkdirSync(presence, { recursive: true });
  pane.detection.pid = process.pid;
  pane.launch = new Launch({ provider: "antigravity", env: [["HOME", account]] });
  pane.attachment.provisional.provider = "antigravity";
  server.runtime.panes.push(pane);
  let fd: number | null = null;
  const lock = (session: string | null) => {
    if (fd !== null) closeSync(fd);
    fd = session === null ? null : openSync(join(presence, session + ".lock"), "w");
  };
  const poll = async () => {
    worker.reconcile(server.runtime);
    await worker.run();
  };
  afterEach(() => {
    lock(null);
    worker.stop();
    observers.stop(server);
    terminal.destroy();
    rmSync(account, { force: true, recursive: true });
  });
  return { root, account, server, pane, worker, lock, poll };
}

supported(
  "Antigravity clears a lost selection and its resume target, even before the session index exists",
  async () => {
    const { root, server, pane, worker, lock, poll, account } = fixture();
    // agy sometimes creates the index before its schema exists.
    new Database(database(root)).close();
    lock(first);
    await poll();
    expect(observers.snapshotActor(server, "antigravity", worker.take()[0])?.state.sessionId()).toBe(first);
    expect(pane.resume_hint.args()).toEqual(["--conversation", first]);
    expect(await selected(2147483647, account)).toBeUndefined();

    lock(null);
    await poll();
    const [lost] = worker.takeMissed();
    observers.missed(server, "antigravity", lost);
    expect(pane.attachment.actor).toBeNull();
    expect(pane.agent().provider).toBe("antigravity");
    expect(pane.resume_hint.args()).toBeNull();

    lock(second);
    await poll();
    expect(observers.snapshotActor(server, "antigravity", worker.take()[0])?.state.sessionId()).toBe(second);
    observers.missed(server, "antigravity", lost);
    expect(pane.agent().sessionId()).toBe(second);
    expect(pane.resume_hint.args()).toEqual(["--conversation", second]);
  },
);

supported("a queued selection cannot attach to a replacement foreground process or provider", async () => {
  const { server, pane, worker, lock, poll } = fixture();
  lock(first);
  await poll();
  const [snapshot] = worker.take();
  pane.detection.pid++;
  expect(observers.snapshotActor(server, "antigravity", snapshot)).toBeNull();
  pane.detection.pid--;
  pane.attachment.provisional.provider = "codex";
  expect(observers.snapshotActor(server, "antigravity", snapshot)).toBeNull();
  expect(pane.attachment.actor).toBeNull();
  expect(pane.resume_hint.args()).toBeNull();
});

supported("Antigravity retries a failed presence inspection before expiring its last known selection", async () => {
  const { root, server, pane, worker, lock, poll } = fixture(),
    at = Date.now(),
    now = spyOn(Date, "now").mockReturnValue(at);
  try {
    lock(first);
    await poll();
    observers.snapshotActor(server, "antigravity", worker.take()[0]);
    renameSync(root, root + ".offline");
    writeFileSync(root, "");
    await poll();
    expect(worker.takeMissed()).toEqual([]);
    now.mockReturnValue(at + 10000);
    await poll();
    const [miss] = worker.takeMissed();
    observers.missed(server, "antigravity", miss);
    expect(pane.attachment.actor).toBeNull();
    expect(pane.resume_hint.args()).toBeNull();
  } finally {
    now.mockRestore();
  }
});

supported("a lost or replaced Antigravity selection supersedes queued observations", async () => {
  const { server, pane, worker, lock, poll } = fixture();
  lock(first);
  await poll();
  lock(null);
  await poll();
  expect(worker.take()).toEqual([]);
  lock(first);
  await poll();
  observers.snapshotActor(server, "antigravity", worker.take()[0]);
  lock(null);
  await poll();
  lock(second);
  await poll();
  expect(worker.takeMissed()).toEqual([]);
  observers.snapshotActor(server, "antigravity", worker.take()[0]);
  expect(pane.agent().sessionId()).toBe(second);
  expect(pane.resume_hint.args()).toEqual(["--conversation", second]);
});

supported("a duplicate Antigravity pane never binds a stale --conversation argument", async () => {
  const { server, account, pane, worker, lock, poll } = fixture(),
    script = join(account, "agy.ts");
  writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 60000);');
  const cli = Bun.spawn([process.execPath, script, "--conversation", first], { stdout: "pipe" });
  try {
    await cli.stdout.getReader().read();
    pane.detection.pid = cli.pid;
    pane.terminal.feed("⚠ Conversation already open");
    // The original CLI owns the requested lock. This CLI could since have resumed any other occupied session.
    lock(first);
    await poll();
    expect(worker.take()).toEqual([]);
    const initial = server.runtime.conversations.get("antigravity", first);
    pane.attachment.select(initial);
    pane.resume_hint.observe(initial.state);
    await poll();
    const [lost] = worker.takeMissed();
    observers.missed(server, "antigravity", lost);
    expect(pane.attachment.actor).toBeNull();
    expect(pane.resume_hint.args()).toBeNull();
    await poll();
    expect(worker.take()).toEqual([]);
  } finally {
    cli.kill();
    await cli.exited;
  }
});

supported("a stable Antigravity subagent stays visible throughout a long-running turn", async () => {
  const { root, server, pane, worker, lock, poll } = fixture();
  const db = new Database(database(root)),
    at = Date.now(),
    now = spyOn(Date, "now").mockReturnValue(at),
    registry = server.runtime.conversations;
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "CREATE TABLE conversation_summaries (conversation_id TEXT, parent_conversation_id TEXT, title TEXT, agent_name TEXT, workspace_uris TEXT, status TEXT, killed INTEGER, last_modified_time TEXT)",
    );
    const row = db.query(
      "INSERT INTO conversation_summaries VALUES (?, ?, '', '', '[]', 'CASCADE_RUN_STATUS_RUNNING', 0, '2025-01-01')",
    );
    row.run(first, "");
    row.run(second, first);
    lock(first);
    for (let elapsed = 0; elapsed <= 30000; elapsed += 5000) {
      now.mockReturnValue(at + elapsed);
      await poll();
      for (const snapshot of worker.take()) {
        const actor = observers.snapshotActor(server, "antigravity", snapshot)!;
        actor.observeSnapshot(snapshot, false, Date.now() * 1000);
        registry.observeChildren(actor, snapshot, Date.now() * 1000);
      }
      const rows = registry.items.map(a => conversation({ ...a, agent: a.state }));
      expect(childrenAvailable(rows, pane.attachment.actor!.id, Date.now() * 1000)).toBe(true);
      expect(pane.agent().subagents.running).toBe(1);
    }
    // The WAL changes between heartbeat polls.
    await poll();
    expect(worker.take()).toEqual([]);
    db.query("UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE' WHERE conversation_id = ?").run(
      second,
    );
    now.mockReturnValue(at + 31000);
    await poll();
    expect(worker.take()).toMatchObject([
      { subagents: { running: 0 }, children: [{ session: second, state: "idle" }] },
    ]);
  } finally {
    now.mockRestore();
    db.close();
  }
});
