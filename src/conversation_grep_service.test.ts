import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as protocol from "./protocol";
import { Searches, budget, prepare, type Command, type Event } from "./conversation_grep_service";
import type { Client } from "./peer";
import type { Runtime } from "./runtime";

const runtime = {
  workspaces: {
    get: (id: number) =>
      id === 3
        ? {
            id: 3,
            cwd: "/proj",
            name: () => "proj",
            worktrees: { entries: [{ path: "/proj/inside" }, { path: "/elsewhere/wt" }] },
          }
        : undefined,
  },
} as unknown as Runtime;
const request = (fields: object = {}) =>
  protocol.decode("conversation.grep", { patterns: ["needle"], workspace: "*", ...fields });
const client = () => ({ dead: false, queued: 0 }) as Client & { dead: boolean; queued: number };
const line = (session: string) => ({ source: { provider: "codex", session, cwd: "/proj", updated_at: 1 } });
const summary = {
  candidates: 1,
  returned: 1,
  truncated: false,
  limit_reached: false,
  capped_sessions: 0,
  warnings: [],
};
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

/** Searches on a fake worker, lock and clock; `hold` makes each lock wait for
 * `grant`, and `broken` makes the first worker fail to start. */
function world(hold = false, broken = false) {
  const posted: Command[] = [],
    lock = { held: false, taken: 0 },
    counts = { spawned: 0, stopped: 0 };
  let events: { message(event: Event): void; closed(): void } | null = null,
    now = 1000;
  const held: (() => void)[] = [];
  const searches = new Searches(
    e => {
      if (broken && counts.spawned++ === 0) throw Error("WorkerFailed");
      events = e;
      if (!broken) counts.spawned++;
      return {
        post: command => posted.push(command),
        stop: () => {
          counts.stopped++;
        },
      };
    },
    async () => {
      if (hold) await new Promise<void>(resolve => held.push(resolve));
      if (lock.held) return null;
      lock.held = true;
      lock.taken++;
      return () => {
        lock.held = false;
      };
    },
    () => now,
    async () => [],
  );
  return {
    searches,
    posted,
    lock,
    counts,
    send: (event: Event) => events!.message(event),
    closed: () => events!.closed(),
    advance: (ms: number) => (now += ms),
    /** Lets the oldest held lock request through. */
    grant: () => held.shift()!(),
    /** The search the worker was last told to run. */
    last: () => posted.filter(c => c.type === "search").at(-1)!,
    start(c: Client, fields: object = {}, more: ((value: object) => void) | null = null) {
      const abort = new AbortController(),
        result = searches.search(runtime, c, request(fields), abort.signal, more);
      result.catch(() => {});
      return { result, abort };
    },
  };
}

test("a search holds the index lock until its worker is done, streaming only while the client's queue is empty", async () => {
  const w = world(),
    c = client(),
    parts: object[] = [];
  const { result } = w.start(c, { stream: true }, part => parts.push(part));
  await settled();
  const search = w.last();
  expect(search).toMatchObject({ type: "search", locked: true, cap: budget });
  w.send({ type: "lines", id: search.id, lines: [line("a")] as any });
  expect(parts).toEqual([{ matches: [line("a")] }]);
  // Too soon after the last batch, then the client is busy: both wait.
  w.send({ type: "lines", id: search.id, lines: [line("b")] as any });
  expect(parts).toHaveLength(1);
  w.advance(100);
  c.queued = 5;
  w.searches.tick();
  expect(parts).toHaveLength(1);
  c.queued = 0;
  w.searches.tick();
  expect(parts).toEqual([{ matches: [line("a")] }, { matches: [line("b")] }]);
  w.send({ type: "lines", id: search.id, lines: [line("c")] as any });
  expect(w.lock.held).toBe(true);
  w.send({ type: "done", id: search.id, summary });
  // What no batch carried comes with the reply.
  expect(await result).toEqual({ matches: [line("c")] as any, summary });
  expect(w.lock.held).toBe(false);
  w.closed();
});

test("without streaming, every match comes with the reply", async () => {
  const w = world();
  const { result } = w.start(client());
  await settled();
  const id = w.last().id;
  w.send({ type: "lines", id, lines: [line("a")] as any });
  w.send({ type: "lines", id, lines: [line("b")] as any });
  w.send({ type: "done", id, summary });
  expect((await result).matches).toEqual([line("a"), line("b")] as any);
  w.closed();
});

test("a newer search under the same key cancels the running one at once, and starts once the worker lets go", async () => {
  const w = world(),
    c = client(),
    other = client();
  const first = w.start(c, { key: "resume" });
  await settled();
  const id = w.last().id;
  // Another client's search under the same key waits its turn.
  const theirs = w.start(other, { key: "resume" });
  const second = w.start(c, { key: "resume" });
  await expect(first.result).rejects.toThrow("Cancelled");
  expect(w.posted.at(-1)).toEqual({ type: "cancel", id });
  // A late batch from the cancelled search goes nowhere.
  w.send({ type: "lines", id, lines: [line("a")] as any });
  expect(w.lock.held).toBe(true);
  w.send({ type: "cancelled", id });
  await settled();
  expect(w.last().id).not.toBe(id);
  w.send({ type: "done", id: w.last().id, summary });
  await expect(theirs.result).resolves.toMatchObject({ summary });
  await settled();
  w.send({ type: "done", id: w.last().id, summary });
  await expect(second.result).resolves.toMatchObject({ summary });
  w.closed();
});

test("a worker that ignores a cancel is stopped, and the lock goes only once it has", async () => {
  const w = world(),
    c = client();
  const first = w.start(c, { key: "resume" });
  await settled();
  const second = w.start(c, { key: "resume" });
  await expect(first.result).rejects.toThrow("Cancelled");
  w.advance(1000);
  w.searches.tick();
  expect(w.counts.stopped).toBe(0);
  w.advance(1500);
  w.searches.tick();
  expect(w.counts.stopped).toBe(1);
  expect(w.lock.held).toBe(true);
  w.closed();
  await settled();
  expect(w.counts.spawned).toBe(2);
  expect(w.last()).toMatchObject({ locked: true });
  w.send({ type: "done", id: w.last().id, summary });
  await expect(second.result).resolves.toMatchObject({ summary });
  w.closed();
});

test("a client that leaves, a search that runs too long, and a reload each end a search", async () => {
  const w = world(),
    c = client();
  const gone = w.start(c);
  await settled();
  c.dead = true;
  w.searches.tick();
  await expect(gone.result).rejects.toThrow("Cancelled");
  w.send({ type: "cancelled", id: w.last().id });
  const slow = w.start(client());
  await settled();
  w.advance(31_000);
  w.searches.tick();
  await expect(slow.result).rejects.toThrow("SearchTimedOut");
  w.send({ type: "cancelled", id: w.last().id });
  const reloading = w.start(client());
  await settled();
  reloading.abort.abort();
  await expect(reloading.result).rejects.toThrow("Reloading");
  w.send({ type: "cancelled", id: w.last().id });
  expect(w.lock.held).toBe(false);
  w.closed();
});

test("a search's deadline counts from when it arrived, so one waiting its turn is answered in time too", async () => {
  const w = world();
  const running = w.start(client());
  await settled();
  w.advance(20_000);
  const waiting = w.start(client());
  w.advance(11_000);
  w.searches.tick();
  await expect(running.result).rejects.toThrow("SearchTimedOut");
  let answered = false;
  waiting.result.finally(() => (answered = true)).catch(() => {});
  await settled();
  expect(answered).toBe(false);
  // The worker lets go of the first; the second starts with 19 s left.
  w.send({ type: "cancelled", id: w.last().id });
  await settled();
  w.advance(20_000);
  w.searches.tick();
  await expect(waiting.result).rejects.toThrow("SearchTimedOut");
  // One that never gets to run is answered from the queue.
  w.send({ type: "cancelled", id: w.last().id });
  const first = w.start(client()),
    queued = w.start(client());
  await settled();
  w.advance(31_000);
  w.searches.tick();
  await expect(first.result).rejects.toThrow("SearchTimedOut");
  await expect(queued.result).rejects.toThrow("SearchTimedOut");
  w.closed();
});

test("stop ends a client's search under a key, running or waiting, and no one else's", async () => {
  const w = world(),
    mine = client(),
    theirs = client();
  const running = w.start(mine, { key: "resume" });
  await settled();
  const other = w.start(theirs, { key: "resume" }),
    otherKey = w.start(mine, { key: "else" }),
    queued = w.start(client(), {});
  w.searches.stop(mine, "resume");
  await expect(running.result).rejects.toThrow("Cancelled");
  expect(w.posted.at(-1)).toMatchObject({ type: "cancel" });
  // Nothing under the key is fine.
  w.searches.stop(mine, "missing");
  w.send({ type: "cancelled", id: w.last().id });
  for (const job of [other, otherKey, queued]) {
    await settled();
    w.send({ type: "done", id: w.last().id, summary });
    await expect(job.result).resolves.toMatchObject({ summary });
  }
  w.closed();
});

test("a search still waiting for the lock is neither stopped nor failed by what happens to the worker", async () => {
  const w = world(true),
    c = client();
  // A worker exists from an earlier search.
  const earlier = w.start(c);
  await settled();
  w.grant();
  await settled();
  w.send({ type: "done", id: w.last().id, summary });
  await earlier.result;
  // One waits for the lock, and a newer search under its key cancels it.
  const waiting = w.start(c, { key: "resume" });
  await settled();
  const newer = w.start(c, { key: "resume" });
  await expect(waiting.result).rejects.toThrow("Cancelled");
  // Not posted, it gives the worker no reason to be stopped.
  w.advance(5_000);
  w.searches.tick();
  expect(w.counts.stopped).toBe(0);
  // The worker exits on its own meanwhile; the newer search runs on the next one.
  w.closed();
  w.grant();
  await settled();
  w.grant();
  await settled();
  expect(w.counts.spawned).toBe(2);
  w.send({ type: "done", id: w.last().id, summary });
  await expect(newer.result).resolves.toMatchObject({ summary });
  expect(w.lock.held).toBe(false);
  w.closed();
});

test("a newer search ends the last under its key even when it's refused", async () => {
  const w = world(),
    c = client();
  const running = w.start(c, { key: "resume" });
  await settled();
  const refused = w.start(c, { key: "resume", patterns: [] });
  await expect(refused.result).rejects.toThrow("MissingPattern");
  await expect(running.result).rejects.toThrow("Cancelled");
  w.send({ type: "cancelled", id: w.last().id });
  expect(w.lock.held).toBe(false);
  w.closed();
});

test("a worker that can't start fails its search, not the ones after it", async () => {
  const w = world(false, true);
  const first = w.start(client());
  await expect(first.result).rejects.toThrow("WorkerFailed");
  expect(w.lock.held).toBe(false);
  const second = w.start(client());
  await settled();
  w.send({ type: "done", id: w.last().id, summary });
  await expect(second.result).resolves.toMatchObject({ summary });
  w.closed();
});

test("a search waiting for its lock before any worker exists still meets its deadline", async () => {
  const w = world(true);
  const waiting = w.start(client());
  await settled();
  expect(w.counts.spawned).toBe(0);
  w.advance(31_000);
  w.searches.tick();
  await expect(waiting.result).rejects.toThrow("SearchTimedOut");
  // Its lock, when it comes, is let go at once.
  w.grant();
  await settled();
  expect(w.lock.held).toBe(false);
  expect(w.counts.spawned).toBe(0);
});

test("a cancel without a key stops nothing", async () => {
  const w = world(),
    c = client();
  const plain = w.start(c);
  await settled();
  w.searches.stop(c, "");
  w.send({ type: "done", id: w.last().id, summary });
  await expect(plain.result).resolves.toMatchObject({ summary });
  w.closed();
});

test("an idle worker is stopped after a while", async () => {
  const w = world();
  const { result } = w.start(client());
  await settled();
  w.send({ type: "done", id: w.last().id, summary });
  await result;
  w.advance(29_000);
  w.searches.tick();
  expect(w.counts.stopped).toBe(0);
  w.advance(2000);
  w.searches.tick();
  expect(w.counts.stopped).toBe(1);
  w.closed();
});

test("a request takes corgi grep's defaults and names a workspace by ID, absolute path or '*'", () => {
  const all = prepare(runtime, request());
  expect(all.options).toMatchObject({ workspace: "*", folders: [], limit: 10, maxCount: 3, age: 30 * 86400000 });
  expect(all.options).toMatchObject({ case: "sensitive", fixed: false, word: false, line: false });
  expect(all.display).toMatchObject({ json: true, maxLineChars: 240, maxOutputChars: 0 });
  // A workspace's worktrees outside its folder come with it.
  expect(prepare(runtime, request({ workspace: "3" })).options).toMatchObject({
    workspace: "/proj",
    folders: ["/elsewhere/wt"],
  });
  expect(prepare(runtime, request({ workspace: "/nowhere/here" })).options.workspace).toBe("/nowhere/here");
  for (const workspace of ["7", "proj", "relative/dir"])
    expect(() => prepare(runtime, request({ workspace }))).toThrow("InvalidWorkspace");
  const set = prepare(
    runtime,
    request({ case: "insensitive", fixed: true, max_age: 0, limit: 1000, max_count: 1, max_line: 160 }),
  );
  expect(set.options).toMatchObject({ case: "insensitive", fixed: true, age: 0, limit: 1000, maxCount: 1 });
  expect(set.display.maxLineChars).toBe(160);
  // A returned conversation is found by ID, whatever age or workspace.
  expect(prepare(runtime, request({ workspace: "3", session: "codex:x" })).options).toMatchObject({
    workspace: "*",
    age: 0,
    session: "codex:x",
  });
  expect(prepare(runtime, request({ only_matching: true, context: 2 })).options).toMatchObject({
    context: 0,
    before: 0,
    after: 0,
  });
  expect(() => prepare(runtime, request({ patterns: [] }))).toThrow("MissingPattern");
  expect(() => prepare(runtime, request({ max_count: 0 }))).toThrow("InvalidCount");
});

test("the worker thread searches transcripts as corgi grep --json does, and saves what it indexed", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "corgi-grep-worker-"))),
    codex = path.join(dir, "codex"),
    saved = process.env.XDG_CACHE_HOME;
  fs.mkdirSync(path.join(codex, "sessions"), { recursive: true });
  const transcript = (id: string, text: string) =>
    fs.writeFileSync(
      path.join(codex, "sessions", id + ".jsonl"),
      [
        { type: "session_meta", payload: { id, cwd: "/project" } },
        {
          type: "response_item",
          timestamp: new Date().toISOString(),
          payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        },
      ]
        .map(record => JSON.stringify(record) + "\n")
        .join(""),
    );
  transcript("one", "where is the Needle (literal)?");
  transcript("two", "no match here\nsecond line with an anchor");
  transcript("big", "bigneedle " + "x".repeat(budget + 1000));
  let clock = 1000;
  const searches = new Searches(
    undefined,
    undefined,
    () => clock,
    async () => [{ provider: "codex", root: codex }],
  );
  try {
    process.env.XDG_CACHE_HOME = path.join(dir, "cache");
    const reply = await searches.search(
      runtime,
      client(),
      request({ patterns: ["needle (lit"], fixed: true, case: "insensitive", max_count: 1, max_age: 0 }),
      new AbortController().signal,
      null,
    );
    expect(reply.matches).toHaveLength(1);
    expect(reply.matches[0]).toMatchObject({
      source: { provider: "codex", session: "one", cwd: "/project" },
      hits: [{ text: "where is the Needle (literal)?", role: "user", context: false }],
    });
    expect(reply.summary).toMatchObject({ candidates: 3, returned: 1, truncated: false, limit_reached: false });
    // It held the lock, so the next search reads the index it saved.
    expect(fs.existsSync(path.join(dir, "cache", "corgi", "conversation-grep-v2", "index.json"))).toBe(true);
    // A hit too big for the budget comes clipped, ending the search, rather than not at all.
    const big = await searches.search(
      runtime,
      client(),
      request({ patterns: ["bigneedle"], fixed: true, max_line: 0, max_age: 0 }),
      new AbortController().signal,
      null,
    );
    expect(big.matches).toHaveLength(1);
    expect(big.matches[0]).toMatchObject({ source: { session: "big" }, hits: [{ clipped: true }] });
    expect(JSON.stringify(big.matches).length).toBeLessThan(budget);
    expect(big.summary).toMatchObject({ returned: 1, truncated: true });
    // Line anchors and whole lines match a conversation's lines, not its text as one.
    const session = async (fields: object) =>
      (
        await searches.search(runtime, client(), request({ max_age: 0, ...fields }), new AbortController().signal, null)
      ).matches.map(m => m.source.session);
    expect(await session({ patterns: ["^second"] })).toEqual(["two"]);
    expect(await session({ patterns: ["anchor$"] })).toEqual(["two"]);
    expect(await session({ patterns: ["second line with an anchor"], line: true })).toEqual(["two"]);
    expect(await session({ patterns: ["^line"] })).toEqual([]);
    // A warm-up needs no pattern and finds nothing; it only reads ahead.
    const warmed = await searches.search(
      runtime,
      client(),
      request({ patterns: [], warm: true, max_age: 0 }),
      new AbortController().signal,
      null,
    );
    expect(warmed).toMatchObject({ matches: [], summary: { candidates: 3, returned: 0 } });
  } finally {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
    clock += 60_000;
    searches.tick();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
