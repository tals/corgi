import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Option, Worker, active_every, idle_every } from "./preview";
import { Info, Window } from "../usage/account";
import { Text } from "../providers";
import * as accounts from "../accounts";

const variables = [
  "CORGI_ENV_BASE",
  "XDG_STATE_HOME",
  "CORGI_CODEX_BIN",
  "CORGI_CLAUDE_BIN",
  "CORGI_PI_BIN",
  "CORGI_OPENCODE2_BIN",
] as const;
let saved: NodeJS.ProcessEnv, root: string;
beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "corgi-preview-"));
  process.env.CORGI_ENV_BASE = root;
  process.env.XDG_STATE_HOME = root;
  process.env.CORGI_CODEX_BIN = process.execPath;
  process.env.CORGI_CLAUDE_BIN = process.execPath;
  process.env.CORGI_PI_BIN = process.execPath;
  process.env.CORGI_OPENCODE2_BIN = "/nonexistent/opencode";
  accounts.reset();
});
afterEach(() => {
  for (const key of variables)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  accounts.reset();
  rmSync(root, { recursive: true, force: true });
});
function listed(names: string[]) {
  mkdirSync(dirname(accounts.path()), { recursive: true });
  writeFileSync(
    accounts.path(),
    JSON.stringify({
      accounts: names.map(name => ({ provider: "claude", dir: join(root, name), name, managed: false })),
    }),
  );
  accounts.reset();
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
/** Observe a probe event before testing a change through this watcher. */
async function waitForWatcher(watcher: FSWatcher, directory: string, deadline: number) {
  const name = `.watch-ready-${crypto.randomUUID()}`,
    probe = join(directory, name);
  let ready = false;
  const changed = (_event: string, file: string | Buffer | null) => {
    if (file?.toString() === name) ready = true;
  };
  watcher.on("change", changed);
  try {
    while (!ready && performance.now() < deadline) {
      writeFileSync(probe, "");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(ready).toBe(true);
  } finally {
    watcher.off("change", changed);
    rmSync(probe, { force: true });
  }
}
test("a launch preview names the model it shows and where it came from", () => {
  const o = new Option();
  o.setModel("opus", "Project");
  expect(o.model.text()).toBe("opus");
  expect(o.modelLabel()).toBe("Opus");
  expect(o.source.text()).toBe("Project");
});

test("a launch preview prefers the provider's model name and keeps its launch id", async () => {
  const worker = new Worker();
  worker.launcher = async () => ({
    account: async () => new Info(),
    model: async () => ({ model: "custom/private-v2", model_name: "My coding model", source: "Pi settings" }),
    close() {},
  });
  try {
    worker.preview(root);
    await worker.pump();
    const o = worker.preview(root).options.pi;
    expect(o.model.text()).toBe("custom/private-v2");
    expect(o.modelLabel()).toBe("My coding model");
    expect(o.source.text()).toBe("Pi settings");
  } finally {
    await worker.stop();
  }
});

test("a launch preview reads a provider again as soon as a file it reads changes", async () => {
  const worker = new Worker(),
    file = join(root, "picked.json");
  writeFileSync(file, JSON.stringify({ model: "first" }));
  worker.launcher = async () => ({
    account: async () => new Info(),
    model: async () => ({ model: JSON.parse(readFileSync(file, "utf8")).model, source: "test" }),
    watches: () => [file],
    close() {},
  });
  try {
    worker.preview(root);
    await worker.pump();
    expect(worker.preview(root).options.pi.model.text()).toBe("first");
    const deadline = performance.now() + 3000;
    await waitForWatcher(worker.watching.get(file)!, root, deadline);
    // Replaced, as editors and atomic writers do, rather than written in place.
    writeFileSync(file + ".tmp", JSON.stringify({ model: "second" }));
    renameSync(file + ".tmp", file);
    while (worker.preview(root).options.pi.model.text() !== "second" && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      await worker.pump();
    }
    expect(worker.preview(root).options.pi.model.text()).toBe("second");
  } finally {
    await worker.stop();
  }
});

test("accounts are listed before provider reads, and a slow account doesn't delay other rows", async () => {
  listed(["slow", "fast"]);
  const worker = new Worker(),
    slow = Promise.withResolvers<Info>(),
    started: string[] = [];
  worker.launcher = async (provider, account = "") => ({
    account: async () => {
      started.push(provider + account);
      if (account === join(root, "slow")) return slow.promise;
      return Object.assign(new Info(), { signed_in: true, account: new Text("fast@example.com") });
    },
    model: async () => ({ model: "opus", source: "test" }),
    close() {},
  });
  try {
    const first = worker.preview("/project");
    expect(first.pending).toBe(true);
    expect(first.accounts.map(a => a.name)).toEqual(["slow", "fast"]);
    expect(first.accounts.every(a => a.option.pending)).toBe(true);
    await turn();
    const partial = worker.preview("/project");
    expect(started).toHaveLength(5);
    expect(partial.pending).toBe(true);
    expect(partial.options.codex.pending).toBe(false);
    expect(partial.accounts[0].option.pending).toBe(true);
    expect(partial.accounts[1].option.account.text()).toBe("fast@example.com");
    expect(partial.accounts[1].option.pending).toBe(false);
    // Published snapshots stay unchanged so subscribers can detect the next update.
    expect(first.accounts[1].option.account.text()).toBe("");
    slow.resolve(new Info());
    await worker.pump();
    expect(worker.preview("/project").pending).toBe(false);
    expect(worker.preview("/project").accounts[0].option.pending).toBe(false);
    expect(partial.pending).toBe(true);
  } finally {
    slow.resolve(new Info());
    await worker.stop();
  }
});

test("account edits update a pending list and a failed reader doesn't block completion", async () => {
  listed(["removed"]);
  const worker = new Worker(),
    hold = Promise.withResolvers<Info>();
  worker.launcher = async (provider, account = "") => {
    if (provider === "codex") throw Error("Unavailable");
    return {
      account: async () => (account === join(root, "removed") ? hold.promise : new Info()),
      model: async () => ({ model: "", source: "test" }),
      close() {},
    };
  };
  try {
    worker.preview("/project");
    await turn();
    listed(["added"]);
    expect(worker.preview("/project").accounts.map(a => a.name)).toEqual(["added"]);
    hold.resolve(new Info());
    await worker.pump();
    const result = worker.preview("/project");
    expect(result.pending).toBe(false);
    expect(result.options.codex.pending).toBe(false);
    expect(result.options.codex.usage_error.text()).toBe("account read failed");
    expect(result.accounts.map(a => [a.name, a.option.pending])).toEqual([["added", false]]);
  } finally {
    hold.resolve(new Info());
    await worker.stop();
  }
});

/** Folders `names` signed in to one Claude account. */
function sameLogin(names: string[]) {
  listed(names);
  for (const name of names) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "me@work.dev", accountUuid: "user", organizationUuid: "org" } }),
    );
  }
}
const reading = (used: number) =>
  Object.assign(new Info(), {
    signed_in: true,
    account: new Text("me@work.dev"),
    usage_fetched_at: 1000,
    limits: { windows: [null, new Window({ minutes: 10080, used, reset_at: 10080 * 60 })] },
  });

test("folders signed in to one account share a read, through the folder that worked last", async () => {
  sameLogin(["stale", "fresh"]);
  const worker = new Worker(),
    stale = realpathSync(join(root, "stale")),
    calls: [string, number][] = [];
  worker.launcher = async (provider, account = "") => ({
    account: async (_quit, max_age) => {
      if (provider !== "claude" || !account) return new Info();
      calls.push([account === stale ? "stale" : "fresh", max_age]);
      // The first folder's login wasn't renewed.
      if (account === stale)
        return Object.assign(new Info(), {
          signed_in: true,
          account: new Text("me@work.dev"),
          usage_error: new Text("usage unavailable for this login"),
        });
      return reading(40);
    },
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    worker.preview("/project");
    await worker.pump();
    expect(calls).toEqual([
      ["stale", idle_every - 15],
      ["fresh", idle_every - 15],
    ]);
    // Both folders show the reading, the broken one too.
    for (const a of worker.preview("/project").accounts) {
      expect(a.option.usage_error.text()).toBe("");
      expect(a.option.limits).toMatchObject({ windows: [null, { used: 40 }] });
    }
    // The next read starts with the folder that worked; the other only checks its sign-in.
    calls.length = 0;
    worker.preview("/project", true);
    await worker.pump();
    expect(calls).toEqual([
      ["fresh", idle_every - 15],
      ["stale", Infinity],
    ]);
    // Asking for usage fetches it whatever its age.
    calls.length = 0;
    worker.trackUsage("/project");
    await worker.pump();
    expect(calls[0]).toEqual(["fresh", 0]);
  } finally {
    await worker.stop();
  }
});

test("accounts are read on the daemon's schedule with no one subscribed", async () => {
  const worker = new Worker();
  let reads = 0;
  worker.launcher = async provider => ({
    account: async () => {
      if (provider === "claude") reads++;
      return reading(10 + reads);
    },
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    setSystemTime(new Date(1_000_000_000));
    worker.sample(idle_every);
    await worker.pump();
    expect(reads).toBe(1);
    // A subscriber's job shows the next reading without running again.
    worker.preview("/project");
    await worker.pump();
    expect(reads).toBe(1);
    setSystemTime(new Date(1_000_000_000 + 60_000));
    worker.sample(idle_every);
    await worker.pump();
    expect(reads).toBe(1);
    // Someone uses a viewer: readings older than the active interval are due.
    setSystemTime(new Date(1_000_000_000 + (active_every + 20) * 1000));
    worker.sample(active_every);
    await worker.pump();
    expect(reads).toBe(2);
    expect(worker.preview("/project").options.claude.limits).toMatchObject({ windows: [null, { used: 12 }] });
  } finally {
    setSystemTime();
    await worker.stop();
  }
});
