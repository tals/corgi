import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, source, Store, Worker, type Entry } from "./history";
import * as accounts from "../accounts";
import { byProvider } from "../providers";
test("clip keeps one line within its byte limit at a UTF-8 boundary", () => {
  const out = clip("  a\tb\n\nc\x1b é", 7);
  expect(out.slice(0, 6)).toBe("a b c ");
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(7);
});
test("a viewer gets everything once, then only what changed, and everything from another daemon", () => {
  const w = new Worker();
  w.epoch = 5n;
  w.ready = true;
  const first: Entry = {
      provider: "claude",
      account: "",
      session: "a",
      title: "First",
      first: "",
      last: "",
      cwd: "/w",
      branch: "",
      updated_at: 1,
      interrupted: false,
    },
    second = {
      ...first,
      provider: "codex" as const,
      session: "b",
      title: "Second",
      updated_at: 2,
    };
  w.store.replace([first, second], [source("claude", ""), source("codex", "")]);
  const full = w.update(0n, 0n)!;
  expect(full.full).toBe(true);
  expect(full.entries[0].title).toBe("Second");
  expect(w.update(full.epoch, full.revision)).toBeNull();
  w.store.put(first);
  expect(w.update(full.epoch, full.revision)).toBeNull();
  w.store.put({ ...first, last: "one more thing", updated_at: 9 });
  w.store.remove("codex", "b");
  const delta = w.update(full.epoch, full.revision)!;
  expect(delta.full).toBe(false);
  expect(delta.entries[0].last).toBe("one more thing");
  expect(delta.removed[0].session).toBe("b");
  expect(w.update(4n, delta.revision)!.full).toBe(true);
  w.store.put(second);
  w.store.replace([], [source("claude", "")]);
  expect(w.store.get("codex", "b")).not.toBeNull();
  expect(w.store.get("claude", "a")).toBeNull();
  w.stop();
});
test("a listing drops only the sessions of the accounts it read", () => {
  const store = new Store(),
    entry = (session: string, account: string): Entry => ({
      provider: "claude",
      account,
      session,
      title: "",
      first: "hi",
      last: "hi",
      cwd: "/w",
      branch: "",
      updated_at: 1,
      interrupted: false,
    });
  store.replace(
    [entry("a", ""), entry("w", "/accounts/work")],
    [source("claude", ""), source("claude", "/accounts/work")],
  );
  store.replace([entry("a", "")], [source("claude", "")]);
  expect(store.get("claude", "w")?.account).toBe("/accounts/work");
  store.replace([], [source("claude", "/accounts/work")]);
  expect(store.get("claude", "w")).toBeNull();
  expect(store.get("claude", "a")).not.toBeNull();
});
test("an account that shares the default's history lists each session once, as the default's", async () => {
  const saved = { ...process.env },
    home = realpathSync(mkdtempSync(join(tmpdir(), "corgi-history-")));
  Object.assign(process.env, {
    HOME: home,
    CORGI_ENV_BASE: join(home, "state"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_STATE_HOME: join(home, ".local/state"),
    CORGI_CODEX_BIN: "/nonexistent/codex",
    CORGI_OPENCODE2_BIN: "/nonexistent/opencode",
  });
  accounts.reset();
  const project = join(home, ".claude", "projects", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "22222222-2222-4222-8222-222222222222.jsonl"),
    JSON.stringify({ type: "user", cwd: home, message: { role: "user", content: "hello" } }) + "\n",
  );
  const w = Worker.start();
  try {
    // As Omarchy's account folders link the default's.
    mkdirSync(join(home, "work"));
    symlinkSync(join(home, ".claude", "projects"), join(home, "work", "projects"));
    accounts.add("claude", "work", join(home, "work"));
    await w.refresh();
    await w.sync();
    expect(w.snapshot().entries.map(e => [e.session, e.account])).toEqual([
      ["22222222-2222-4222-8222-222222222222", ""],
    ]);
  } finally {
    await w.stop();
    for (const key of [
      "HOME",
      "CORGI_ENV_BASE",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "XDG_STATE_HOME",
      "CORGI_CODEX_BIN",
      "CORGI_OPENCODE2_BIN",
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    accounts.reset();
    rmSync(home, { recursive: true, force: true });
  }
});
test("a removed agent's sessions leave the list, and come back when it's added back", async () => {
  const saved = { ...process.env },
    home = realpathSync(mkdtempSync(join(tmpdir(), "corgi-history-"))),
    session = "33333333-3333-4333-8333-333333333333";
  Object.assign(process.env, {
    HOME: home,
    CORGI_ENV_BASE: join(home, "state"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_STATE_HOME: join(home, ".local/state"),
    CORGI_CODEX_BIN: "/nonexistent/codex",
    CORGI_OPENCODE2_BIN: "/nonexistent/opencode",
  });
  accounts.reset();
  const project = join(home, ".claude", "projects", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${session}.jsonl`),
    JSON.stringify({ type: "user", cwd: home, message: { role: "user", content: "hello" } }) + "\n",
  );
  const removed = { agent_hidden: byProvider(p => p === "claude"), account_hidden: [] },
    w = Worker.start(removed);
  try {
    await w.refresh();
    expect(w.snapshot().entries).toEqual([]);
    await w.follow({ ...removed, agent_hidden: byProvider(() => false) });
    expect(w.snapshot().entries.map(e => e.session)).toEqual([session]);
    await w.follow(removed);
    expect(w.snapshot().entries).toEqual([]);
  } finally {
    await w.stop();
    for (const key of [
      "HOME",
      "CORGI_ENV_BASE",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "XDG_STATE_HOME",
      "CORGI_CODEX_BIN",
      "CORGI_OPENCODE2_BIN",
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    accounts.reset();
    rmSync(home, { recursive: true, force: true });
  }
});
test("an account added later lists its sessions once it has any, and takes them when it goes", async () => {
  const saved = { ...process.env },
    home = realpathSync(mkdtempSync(join(tmpdir(), "corgi-history-")));
  Object.assign(process.env, {
    HOME: home,
    CORGI_ENV_BASE: join(home, "state"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_STATE_HOME: join(home, ".local/state"),
    CORGI_CODEX_BIN: "/nonexistent/codex",
    CORGI_OPENCODE2_BIN: "/nonexistent/opencode",
  });
  accounts.reset();
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const w = Worker.start();
  try {
    await w.refresh();
    mkdirSync(join(home, "work"));
    const work = accounts.add("claude", "work", join(home, "work"));
    await w.sync();
    // A new account has no projects folder to watch until its first session.
    const project = join(work.dir, "projects", "app");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "11111111-1111-4111-8111-111111111111.jsonl"),
      JSON.stringify({ type: "user", cwd: home, message: { role: "user", content: "hello" } }) + "\n",
    );
    await w.sync();
    expect(w.snapshot().entries.map(e => [e.session, e.account])).toEqual([
      ["11111111-1111-4111-8111-111111111111", work.dir],
    ]);
    await accounts.remove(work);
    await w.sync();
    expect(w.snapshot().entries).toEqual([]);
  } finally {
    await w.stop();
    for (const key of [
      "HOME",
      "CORGI_ENV_BASE",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "XDG_STATE_HOME",
      "CORGI_CODEX_BIN",
      "CORGI_OPENCODE2_BIN",
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    accounts.reset();
    rmSync(home, { recursive: true, force: true });
  }
});
