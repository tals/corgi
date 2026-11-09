import { test, expect, beforeEach, afterEach, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OneAtATime, Option, Worker, active_every, idle_every } from "./preview";
import { Info, Window } from "../usage/account";
import { Provider, Text, byProvider } from "../providers";
import * as accounts from "../accounts";
import * as discovery from "../discovery";
import * as limitHistory from "../usage/limits";
import * as profiles from "../agent_profiles";
import * as visibility from "./visibility";
import type { Launcher } from "../providers/adapter";

const bin = (p: Provider) => `CORGI_${p.toUpperCase()}_BIN`;
/** The providers these tests find installed. */
const installed: Provider[] = Provider.all.filter(p => p !== "opencode2");
const variables = ["CORGI_ENV_BASE", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR", ...Provider.all.map(bin)];
let saved: NodeJS.ProcessEnv, root: string;
beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "corgi-preview-"));
  process.env.CORGI_ENV_BASE = root;
  process.env.XDG_STATE_HOME = root;
  for (const p of Provider.all) process.env[bin(p)] = installed.includes(p) ? process.execPath : `/nonexistent/${p}`;
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

test("saved accounts behind install-on-use shims settle without starting a provider", async () => {
  listed(["work"]);
  const worker = new Worker(),
    found = spyOn(discovery, "installed").mockReturnValue(false),
    lazy = spyOn(discovery, "onDemand").mockImplementation(p => p === "claude"),
    check = spyOn(discovery, "check").mockResolvedValue(),
    launcher = spyOn(worker, "launcher").mockResolvedValue(null);
  try {
    worker.preview(root);
    await worker.pump();
    const account = { provider: "claude" as const, account: join(root, "work") },
      settled = worker.preview(root);
    expect(settled.pending).toBe(false);
    expect(settled.accounts[0].option.pending).toBe(false);
    expect(visibility.account(settled, account, [])).toBe(true);
    worker.sample(idle_every);
    await worker.pump();
    expect(worker.cached(root).accounts[0].option.pending).toBe(false);
    expect(visibility.account(worker.cached(root), account, [])).toBe(true);
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    await worker.stop();
    found.mockRestore();
    lazy.mockRestore();
    check.mockRestore();
    launcher.mockRestore();
  }
});

test("account reads retain the workspace context during background refreshes", async () => {
  const worker = new Worker(),
    reads: (string | undefined)[] = [];
  worker.launcher = async () => ({
    account: async (_quit, _max_age, cwd?: string) => {
      reads.push(cwd);
      return new Info();
    },
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    worker.preview(root);
    await worker.pump();
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([root]));
    reads.length = 0;
    setSystemTime(new Date(Date.now() + idle_every * 2000));
    worker.sample(idle_every);
    await worker.pump();
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([root]));
  } finally {
    await worker.stop();
    setSystemTime();
  }
});

test("account availability stays scoped to each workspace through background refreshes", async () => {
  const worker = new Worker(),
    other = join(root, "other");
  worker.launcher = async () => ({
    account: async (_quit, _max_age, cwd) => Object.assign(new Info(), { signed_in: cwd === root }),
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    worker.preview(root);
    await worker.pump();
    worker.preview(other);
    await worker.pump();
    expect(worker.preview(root).options.pi.signed_in).toBe(true);
    expect(worker.preview(other).options.pi.signed_in).toBe(false);
    setSystemTime(new Date(Date.now() + idle_every * 2000));
    worker.sample(idle_every);
    await worker.pump();
    expect(worker.preview(root).options.pi.signed_in).toBe(true);
    expect(worker.preview(other).options.pi.signed_in).toBe(false);
  } finally {
    await worker.stop();
    setSystemTime();
  }
});

test("a workspace preview queued during a slow sampling round doesn't wait for it", async () => {
  const worker = new Worker(),
    second = join(root, "second"),
    fresh = join(root, "fresh"),
    first_done = Promise.withResolvers<void>(),
    second_started = Promise.withResolvers<void>(),
    second_done = Promise.withResolvers<void>(),
    repeated = Promise.withResolvers<void>(),
    check = spyOn(discovery, "check").mockResolvedValue(),
    start = 1_000_000_000;
  worker.launcher = async () => ({
    account: async () => new Info(),
    model: async cwd => ({ model: cwd, source: "workspace" }),
    close() {},
  });
  try {
    setSystemTime(new Date(start));
    for (const cwd of [root, second]) {
      worker.preview(cwd);
      await worker.pump();
    }
    check.mockClear();
    let first = true;
    check.mockImplementation(async cwd => {
      if (cwd === root) {
        if (!first) return repeated.promise;
        first = false;
        await first_done.promise;
      } else if (cwd === second) {
        second_started.resolve();
        await second_done.promise;
      }
    });
    worker.sample(idle_every);
    const pending = worker.pump();
    expect(worker.preview(fresh).pending).toBe(true);
    // The round waits on `root`; the new folder's preview finishes meanwhile.
    for (let i = 0; i < 50 && worker.preview(fresh).pending; i++) await turn();
    expect(worker.preview(fresh).pending).toBe(false);
    expect(worker.preview(fresh).options.pi.model.text()).toBe(fresh);
    // No second round starts while one is under way.
    setSystemTime(new Date(start + 20_000));
    worker.sample(idle_every);
    first_done.resolve();
    await second_started.promise;
    setSystemTime(new Date(start + 40_000));
    worker.sample(active_every);
    second_done.resolve();
    await pending;
    expect(check.mock.calls.map(([cwd]) => cwd)).toEqual([root, fresh, second]);
    // Sampling waits a full interval from completion, even after a long round.
    check.mockResolvedValue();
    worker.sample(active_every);
    setSystemTime(new Date(start + 54_999));
    worker.sample(active_every);
    expect(check).toHaveBeenCalledTimes(3);
    setSystemTime(new Date(start + 55_000));
    worker.sample(active_every);
    await worker.pump();
    expect(check).toHaveBeenCalledTimes(6);
  } finally {
    first_done.resolve();
    second_done.resolve();
    repeated.resolve();
    await worker.stop();
    check.mockRestore();
    setSystemTime();
  }
});

test("a round and a folder's preview never ask one launcher two things at once", async () => {
  listed(["work"]);
  const worker = new Worker(),
    other = join(root, "other"),
    held = Promise.withResolvers<void>(),
    check = spyOn(discovery, "check").mockResolvedValue(),
    launchers = new Map<string, Launcher>(),
    asking = new Map<string, number>();
  let most = 0,
    holding = false;
  const ask = async <T>(key: string, value: T, wait: boolean) => {
    const now = (asking.get(key) ?? 0) + 1;
    asking.set(key, now);
    most = Math.max(most, now);
    if (wait) await held.promise;
    asking.set(key, asking.get(key)! - 1);
    return value;
  };
  worker.launcher = async (p, account = "") => {
    const key = p + "\0" + account;
    if (!launchers.has(key))
      launchers.set(
        key,
        new OneAtATime({
          account: () => {
            // The first read of the saved account waits until the folder's preview asks too.
            const wait = !holding && account !== "";
            if (wait) holding = true;
            return ask(key, new Info(), wait);
          },
          model: cwd => ask(key, { model: cwd, source: "workspace" }, false),
          close() {},
        }),
      );
    return launchers.get(key)!;
  };
  try {
    worker.sample(idle_every);
    const pending = worker.pump();
    for (let i = 0; i < 50 && !holding; i++) await turn();
    expect(holding).toBe(true);
    worker.preview(other);
    for (let i = 0; i < 20; i++) await turn();
    held.resolve();
    await pending;
    await worker.pump();
    expect(most).toBe(1);
    expect(worker.preview(other).pending).toBe(false);
  } finally {
    held.resolve();
    await worker.stop();
    check.mockRestore();
  }
});

test("a launcher another folder no longer reads closes after the read under way", async () => {
  const worker = new Worker(),
    held = Promise.withResolvers<void>(),
    events: string[] = [];
  const launcher: Launcher = {
    account: async () => {
      await held.promise;
      events.push("read");
      return new Info();
    },
    model: async cwd => ({ model: cwd, source: "workspace" }),
    close: () => void events.push("closed"),
  };
  const opened = new OneAtATime(launcher);
  worker.launchers.set("codex\0", Promise.resolve(opened));
  try {
    const reading = opened.account(worker.quit, 0);
    Reflect.get(worker, "close").call(worker, () => true);
    await turn();
    expect(events).toEqual([]);
    expect(worker.launchers.size).toBe(0);
    held.resolve();
    await reading;
    await turn();
    expect(events).toEqual(["read", "closed"]);
  } finally {
    held.resolve();
    await worker.stop();
  }
});

test("the launchers a worker opens take one call at a time, and start nothing once closed", async () => {
  const worker = new Worker(),
    events: string[] = [];
  try {
    expect(await worker.launcher("claude")).toBeInstanceOf(OneAtATime);
    const closed = new OneAtATime({
      account: async () => (events.push("account"), new Info()),
      model: async cwd => (events.push("model"), { model: cwd, source: "workspace" }),
      close: () => void events.push("closed"),
    });
    await closed.close();
    expect((await closed.account(worker.quit, 0)).signed_in).toBeNull();
    expect(await closed.model(root, worker.quit)).toEqual({ model: "", source: "" });
    expect(events).toEqual(["closed"]);
  } finally {
    await worker.stop();
  }
});

test("a fresh reading asked for while one is under way comes after it", async () => {
  const worker = new Worker(),
    held = Promise.withResolvers<void>(),
    check = spyOn(discovery, "check").mockResolvedValue();
  let reads = 0,
    holding = false;
  worker.launcher = async p =>
    new OneAtATime({
      account: async () => {
        if (p !== "claude") return new Info();
        reads++;
        if (!holding) {
          holding = true;
          await held.promise;
        }
        return new Info();
      },
      model: async cwd => ({ model: cwd, source: "workspace" }),
      close() {},
    });
  try {
    // A round's read is under way when a viewer asks this folder for a fresh one.
    worker.sample(idle_every);
    const pending = worker.pump();
    for (let i = 0; i < 50 && !holding; i++) await turn();
    expect(holding).toBe(true);
    worker.preview(process.cwd(), true);
    for (let i = 0; i < 20; i++) await turn();
    expect(reads).toBe(1);
    held.resolve();
    await pending;
    await worker.pump();
    expect(reads).toBe(2);
  } finally {
    held.resolve();
    await worker.stop();
    check.mockRestore();
  }
});

test("cached previews retain each workspace's installations without starting reads", async () => {
  listed(["work"]);
  const worker = new Worker(),
    other = join(root, "other"),
    check = spyOn(discovery, "check").mockResolvedValue(),
    installed = spyOn(discovery, "installed").mockImplementation((p, cwd) =>
      cwd === root ? p === "codex" : p === "claude",
    );
  let reads = 0;
  worker.launcher = async () => ({
    account: async () => {
      reads++;
      return reading(42);
    },
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  const snapshots = () => {
    expect(worker.cached(root).installed.codex).toBe(true);
    expect(worker.cached(root).installed.claude).toBe(false);
    expect(worker.cached(root).accounts).toHaveLength(0);
    expect(worker.cached(other).installed.codex).toBe(false);
    expect(worker.cached(other).installed.claude).toBe(true);
    expect(worker.cached(other).accounts.map(a => a.name)).toEqual(["work"]);
    expect(worker.cached(other).accounts[0].option.limits).toMatchObject({ windows: [null, { used: 42 }] });
  };
  try {
    for (const cwd of [root, other]) {
      worker.preview(cwd);
      await worker.pump();
    }
    snapshots();
    setSystemTime(new Date(Date.now() + idle_every * 2000));
    worker.sample(idle_every);
    await worker.pump();
    const before = { reads, checks: check.mock.calls.length };
    snapshots();
    expect(worker.cached(join(root, "unvisited"))).toMatchObject({ pending: false, accounts: [] });
    expect({ reads, checks: check.mock.calls.length }).toEqual(before);
    expect(worker.jobs).toHaveLength(2);
  } finally {
    await worker.stop();
    check.mockRestore();
    installed.mockRestore();
    setSystemTime();
  }
});

test("a project model keeps an agent visible after a failed account read", async () => {
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-home");
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ defaultModel: "project-model" }));
  const worker = new Worker();
  worker.launcher = async provider => ({
    account: async () => {
      if (provider === "pi") throw Error("Unavailable");
      return Object.assign(new Info(), { signed_in: provider === "codex" });
    },
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    worker.preview(root);
    await worker.pump();
    expect(visibility.defaults(worker.preview(root), [], [])).toMatchObject({ pi: true, codex: true });
    const other = join(root, "other");
    worker.preview(other);
    await worker.pump();
    expect(visibility.defaults(worker.preview(other), [], [])).toMatchObject({ pi: false, codex: true });
  } finally {
    await worker.stop();
  }
});

test.each([
  ["pi", ".pi/settings.json", '{"defaultModel":"project-model"}'],
  ["omp", ".omp/config.yml", "modelRoles:\n  default: local/project-model\n"],
] as const)("a project model shows the %s shim only in its workspace", async (provider, path, settings) => {
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-home");
  const file = join(root, path),
    other = join(root, "other");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, settings);
  const worker = new Worker(),
    found = spyOn(discovery, "installed").mockImplementation(p => p === "codex"),
    lazy = spyOn(discovery, "onDemand").mockImplementation(p => p === provider),
    check = spyOn(discovery, "check").mockResolvedValue(),
    launcher = spyOn(worker, "launcher").mockImplementation(async () => ({
      account: async () => Object.assign(new Info(), { signed_in: true }),
      model: async () => ({ model: "", source: "test" }),
      close() {},
    }));
  const snapshots = () => {
    for (const cwd of [root, other]) {
      const preview = worker.cached(cwd);
      expect(preview.installed[provider]).toBe(false);
      expect(preview.on_demand[provider]).toBe(true);
      expect(preview.configured[provider]).toBe(cwd === root);
      expect(preview.options[provider].pending).toBe(false);
      expect(visibility.defaults(preview, [], [])).toMatchObject({ [provider]: cwd === root, codex: true });
    }
    expect(launcher).toHaveBeenCalled();
    expect(launcher.mock.calls.every(([p]) => p === "codex")).toBe(true);
  };
  try {
    for (const cwd of [root, other]) {
      worker.preview(cwd);
      await worker.pump();
    }
    snapshots();
    worker.sample(idle_every);
    await worker.pump();
    snapshots();
  } finally {
    await worker.stop();
    found.mockRestore();
    lazy.mockRestore();
    check.mockRestore();
    launcher.mockRestore();
  }
});

test("discovery settles absent providers and reads account availability for each workspace", async () => {
  const worker = new Worker(),
    checked = Promise.withResolvers<void>(),
    signIn = Promise.withResolvers<Info>(),
    check = spyOn(discovery, "check").mockImplementation(() => checked.promise);
  worker.launcher = async p => ({
    account: async () => (p === "pi" || p === "omp" ? signIn.promise : Object.assign(new Info(), { signed_in: true })),
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    const first = worker.preview(root);
    expect(first.options.pi.pending).toBe(true);
    expect(first.options.opencode2.pending).toBe(true);
    checked.resolve();
    await turn();
    const partial = worker.preview(root);
    expect(partial.options.opencode2.pending).toBe(false);
    expect(partial.installed.opencode2).toBe(false);
    expect(partial.options.pi.pending).toBe(true);
    expect(partial.options.codex.signed_in).toBe(true);
    signIn.resolve(Object.assign(new Info(), { signed_in: false }));
    await worker.pump();
    const next = worker.preview(join(root, "other"));
    expect(next.pending).toBe(true);
    expect(next.options.pi.signed_in).toBeNull();
    expect(next.options.omp.signed_in).toBeNull();
    expect(next.options.codex.signed_in).toBeNull();
    await worker.pump();
    const refreshed = worker.preview(root, true);
    expect(refreshed.options.pi.signed_in).toBe(false);
    await worker.pump();
    expect(worker.preview(root).options.pi.signed_in).toBe(false);
  } finally {
    checked.resolve();
    signIn.resolve(new Info());
    await worker.stop();
    check.mockRestore();
  }
});

test("unchanged launch previews retain identity across polling and installation refreshes", async () => {
  const worker = new Worker(),
    monotonic = spyOn(performance, "now").mockReturnValue(0);
  worker.launcher = async () => ({
    account: async () => new Info(),
    model: async () => ({ model: "stable", source: "test" }),
    close() {},
  });
  try {
    const start = 1_000_000_000;
    setSystemTime(new Date(start));
    worker.preview(root);
    await worker.pump();
    const first = worker.preview(root);
    expect(first.pending).toBe(false);
    for (let ms = 100; ms <= 10000; ms += 100) {
      setSystemTime(new Date(start + ms));
      monotonic.mockReturnValue(ms);
      expect(worker.preview(root)).toBe(first);
    }
    accounts.renameDefault("codex", "work");
    const renamed = worker.preview(root);
    expect(renamed).not.toBe(first);
    expect(renamed.names.codex).toBe("work");
    expect(first.names.codex).toBe("");
    await worker.pump();
    const settled = worker.preview(root);
    expect(settled.pending).toBe(false);
    expect(worker.preview(root)).toBe(settled);
    // Starting a fresh read must not change the already-published snapshot.
    const pending = worker.preview(root, true);
    expect(pending.pending).toBe(true);
    expect(settled.pending).toBe(false);
  } finally {
    await worker.stop();
    monotonic.mockRestore();
    setSystemTime();
  }
});

test("install discovery expires despite wall-clock rollback and refresh sees changes immediately", async () => {
  let available = true;
  const found = spyOn(discovery, "installed").mockImplementation(() => available),
    monotonic = spyOn(performance, "now").mockReturnValue(0),
    worker = new Worker();
  worker.launcher = async () => ({
    account: async () => new Info(),
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    setSystemTime(new Date(1_000_000_000));
    worker.preview(root);
    await worker.pump();
    expect(worker.preview(root).installed.codex).toBe(true);
    available = false;
    monotonic.mockReturnValue(4000);
    setSystemTime(new Date(999_999_000));
    expect(worker.preview(root).installed.codex).toBe(true);
    monotonic.mockReturnValue(5000);
    setSystemTime(new Date(999_998_000));
    expect(worker.preview(root).installed.codex).toBe(false);
    available = true;
    expect(worker.preview(root, true).installed.codex).toBe(true);
  } finally {
    await worker.stop();
    found.mockRestore();
    monotonic.mockRestore();
    setSystemTime();
  }
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
    expect(started).toHaveLength(installed.length + 2);
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

test("taking a row out closes its launcher at once, with nothing asking for a preview", async () => {
  const worker = new Worker(),
    closed: Provider[] = [];
  for (const p of installed)
    worker.launchers.set(
      p + "\0",
      Promise.resolve({
        account: async () => new Info(),
        model: async () => ({ model: "", source: "test" }),
        close: () => void closed.push(p),
      }),
    );
  try {
    worker.follow({ ...worker.removed, agent_hidden: byProvider(p => p === "pi") });
    await turn();
    expect(closed).toEqual(["pi"]);
    expect([...worker.launchers.keys()]).not.toContain("pi\0");
  } finally {
    await worker.stop();
  }
});

test("deleting the saved agent that kept a removed row read closes its launcher on the daemon's schedule", async () => {
  const worker = new Worker(),
    closed: Provider[] = [];
  worker.launcher = async provider => ({
    account: async () => reading(84),
    model: async () => ({ model: "", source: "test" }),
    close: () => void closed.push(provider),
  });
  mkdirSync(dirname(profiles.path()), { recursive: true });
  writeFileSync(
    profiles.path(),
    JSON.stringify([{ id: "pi-fast", provider: "pi", account: "", name: "Pi fast", options: { flags: "", env: [] } }]),
  );
  try {
    setSystemTime(new Date(1_000_000_000));
    worker.follow({ ...worker.removed, agent_hidden: byProvider(p => p === "pi") });
    await worker.pump();
    worker.launchers.set("pi\0", worker.launcher("pi"));
    rmSync(profiles.path());
    worker.sample(idle_every);
    await worker.pump();
    await turn();
    expect(closed).toEqual(["pi"]);
  } finally {
    setSystemTime();
    await worker.stop();
  }
});

test("sign-in refreshes during a pass run again as soon as it finishes", async () => {
  const worker = new Worker(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let reads = 0;
  worker.launcher = async provider => ({
    account: async () => {
      if (provider !== "codex") return new Info();
      const first = ++reads === 1;
      if (first) {
        started.resolve();
        await release.promise;
      }
      return Object.assign(new Info(), {
        signed_in: !first,
        account: new Text(first ? "" : "codex@example.com"),
      });
    },
    model: async () => ({ model: "test", source: "test" }),
    close() {},
  });
  try {
    worker.preview(root);
    await started.promise;
    worker.preview(root, true);
    worker.preview(root, true);
    release.resolve();
    await worker.pump();
    const preview = worker.preview(root);
    expect(reads).toBe(2);
    expect(preview.pending).toBe(false);
    expect(preview.options.codex.signed_in).toBe(true);
    expect(preview.options.codex.account.text()).toBe("codex@example.com");
  } finally {
    release.resolve();
    await worker.stop();
  }
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
      expect(a.option.login).toEqual({ id: "user/org", email: "me@work.dev", service: "claude", workspace: "org" });
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

test("previews carry each cached spend day across a billing reset", async () => {
  sameLogin(["fresh"]);
  const worker = new Worker(),
    day = 86400;
  let at = 99 * day + day / 2,
    period_start = 70 * day,
    used_minor = 12000;
  worker.launcher = async (provider, account = "") => ({
    account: async () =>
      provider === "claude" && account
        ? Object.assign(reading(0), {
            usage_fetched_at: at,
            limits: "metered",
            spend: {
              used_minor,
              limit_minor: 100000,
              currency: "USD",
              exponent: 2,
              period_start,
              reset_at: period_start + 31 * day,
            },
          })
        : new Info(),
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    for (const values of [
      [99, 70, 12000],
      [100, 100, 200],
      [101, 100, 150],
    ]) {
      at = values[0] * day + day / 2;
      period_start = values[1] * day;
      used_minor = values[2];
      setSystemTime(new Date(at * 1000));
      worker.preview("/project", true);
      await worker.pump();
    }
    const option = worker.preview("/project").accounts[0].option;
    expect(option.spend_daily).toEqual([
      { day: 99 * day, period_start: 70 * day, used_minor: 12000 },
      { day: 100 * day, period_start: 100 * day, used_minor: 200 },
      { day: 101 * day, period_start: 100 * day, used_minor: 150 },
    ]);
    expect(option.spend_history).toHaveLength(14);
    expect(option.spend!.used_minor).toBe(150);
  } finally {
    setSystemTime();
    await worker.stop();
  }
});

test("tracking usage in a newly visited workspace forces its first account read", async () => {
  const worker = new Worker(),
    other = join(root, "other"),
    reads: { cwd: string | undefined; maxAge: number | undefined }[] = [];
  worker.launcher = async () => ({
    account: async (_quit, maxAge, cwd) => {
      reads.push({ cwd, maxAge });
      return reading(10);
    },
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    worker.preview(root);
    await worker.pump();
    worker.trackUsage(other);
    await worker.pump();
    const forced = reads.filter(read => read.cwd === other);
    expect(forced.length).toBeGreaterThan(0);
    expect(forced.every(read => read.maxAge === 0)).toBe(true);
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
    expect(worker.cached(process.cwd()).options.claude.limits).toMatchObject({ windows: [null, { used: 11 }] });
    expect(worker.jobs).toHaveLength(0);
    worker.preview(process.cwd());
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
    expect(worker.preview(process.cwd()).options.claude.limits).toMatchObject({ windows: [null, { used: 12 }] });
  } finally {
    setSystemTime();
    await worker.stop();
  }
});

test("cached readings follow account edits sampled after a workspace stops requesting previews", async () => {
  listed(["kept", "removed"]);
  const worker = new Worker(),
    start = 1_000_000_000;
  let reads = 0,
    models = 0;
  worker.launcher = async () => ({
    account: async () => {
      reads++;
      return reading(42);
    },
    model: async () => {
      models++;
      return { model: "opus", source: "test" };
    },
    close() {},
  });
  try {
    setSystemTime(new Date(start));
    worker.preview(root);
    await worker.pump();
    const before = worker.cached(root),
      initialReads = reads,
      initialModels = models;
    expect(before.accounts.map(a => a.name)).toEqual(["kept", "removed"]);

    listed(["kept", "added"]);
    setSystemTime(new Date(start + 60_000));
    worker.sample(idle_every);
    await worker.pump();
    const added = worker.cached(root);
    expect(added.accounts.map(a => a.name)).toEqual(["kept", "added"]);
    expect(added.accounts[1].option.limits).toMatchObject({ windows: [null, { used: 42 }] });
    expect(reads).toBe(initialReads + 1);

    accounts.rename(accounts.known()[0], "renamed");
    accounts.renameDefault("claude", "personal");
    setSystemTime(new Date(start + 120_000));
    worker.sample(idle_every);
    await worker.pump();
    const renamed = worker.cached(root);
    expect(renamed.accounts.map(a => a.name)).toEqual(["renamed", "added"]);
    expect(renamed.names.claude).toBe("personal");
    expect(reads).toBe(initialReads + 1);
    expect(models).toBe(initialModels);
    expect(worker.jobs).toHaveLength(1);
    expect(worker.jobs[0]).toMatchObject({ used: start, updated: start, queued: false });
    expect(before.accounts.map(a => a.name)).toEqual(["kept", "removed"]);
    expect(added.accounts.map(a => a.name)).toEqual(["kept", "added"]);
  } finally {
    await worker.stop();
    setSystemTime();
  }
});

test("a removed row shows who its last read found when its files don't say, and a signed-out account as such", async () => {
  // OpenCode keeps no sign-in Corgi can read without asking it.
  process.env.CORGI_OPENCODE2_BIN = process.execPath;
  listed(["work"]);
  const work = join(root, "work"),
    worker = new Worker(),
    removed = { ...worker.removed, account_hidden: [work] };
  worker.launcher = async provider => ({
    account: async () =>
      Object.assign(reading(84), { account: new Text(provider === "opencode2" ? "me@chatgpt.dev" : "me@work.dev") }),
    model: async () => ({ model: "", source: "test" }),
    close() {},
  });
  try {
    worker.follow(removed);
    await worker.pump();
    worker.preview("/project");
    await worker.pump();
    expect(worker.preview("/project").options.opencode2.account.text()).toBe("me@chatgpt.dev");
    worker.follow({ ...removed, agent_hidden: byProvider(p => p === "opencode2") });
    await worker.pump();
    const preview = worker.preview("/project");
    expect(preview.options.opencode2).toMatchObject({ pending: false, signed_in: true, limits: "none" });
    expect(preview.options.opencode2.account.text()).toBe("me@chatgpt.dev");
    // Its folder names no login, and it was never read.
    expect(preview.accounts.map(a => [a.account, a.option.pending, a.option.signed_in])).toEqual([
      [work, false, false],
    ]);
  } finally {
    await worker.stop();
  }
});

test("a removed agent isn't read, shows only who signed in, and is read again once added back", async () => {
  const pi = join(root, "pi");
  mkdirSync(pi);
  writeFileSync(
    join(pi, "auth.json"),
    JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", email: "me@pi.dev" } }),
  );
  process.env.PI_CODING_AGENT_DIR = pi;
  const worker = new Worker(),
    reads: Provider[] = [],
    closed: Provider[] = [],
    none = { agent_hidden: byProvider(() => false), account_hidden: [], commands: [] },
    removed = { ...none, agent_hidden: byProvider(p => p === "pi") };
  const fake = (provider: Provider) => ({
    account: async () => {
      reads.push(provider);
      return reading(84);
    },
    model: async () => ({ model: "", source: "test" }),
    close: () => void closed.push(provider),
  });
  worker.launcher = async provider => fake(provider);
  for (const p of installed) worker.launchers.set(p + "\0", Promise.resolve(fake(p)));
  try {
    setSystemTime(new Date(1_000_000_000));
    worker.preview("/project");
    await worker.pump();
    expect(reads).toContain("pi");
    worker.follow(removed);
    await worker.pump();
    await turn();
    expect(closed).toEqual(["pi"]);
    const option = worker.preview("/project").options.pi;
    expect(option.pending).toBe(false);
    expect(option.account.text()).toBe("me@pi.dev");
    expect(option.limits).toBe("none");
    expect(option.history).toEqual(limitHistory.none());
    // Neither the daemon's schedule nor a refresh reads it.
    reads.length = 0;
    setSystemTime(new Date(1_000_000_000 + idle_every * 2000));
    worker.sample(idle_every);
    worker.preview("/project", true);
    await worker.pump();
    expect(reads).toContain("claude");
    expect(reads).not.toContain("pi");
    expect(worker.preview("/project").options.pi.limits).toBe("none");
    // A saved agent that runs in it keeps it read.
    writeFileSync(
      profiles.path(),
      JSON.stringify([
        { id: "pi-fast", provider: "pi", account: "", name: "Pi fast", options: { flags: "", env: [] } },
      ]),
    );
    worker.preview("/project", true);
    await worker.pump();
    expect(reads).toContain("pi");
    expect(worker.preview("/project").options.pi.limits).toMatchObject({ windows: [null, { used: 84 }] });
    rmSync(profiles.path());
    reads.length = 0;
    worker.preview("/project", true);
    await worker.pump();
    expect(reads).not.toContain("pi");
    worker.follow(none);
    await worker.pump();
    expect(reads).toContain("pi");
    expect(worker.preview("/project").options.pi.limits).toMatchObject({ windows: [null, { used: 84 }] });
  } finally {
    setSystemTime();
    await worker.stop();
  }
});

test("a saved command that runs in a removed default keeps it read", async () => {
  const worker = new Worker(),
    reads: Provider[] = [],
    removed = { agent_hidden: byProvider(p => p === "pi"), account_hidden: [], commands: [] };
  worker.launcher = async provider => ({
    account: async () => {
      reads.push(provider);
      return reading(84);
    },
    model: async () => ({ model: "pi-model", source: "test" }),
    close() {},
  });
  try {
    worker.follow({ ...removed, commands: [{ provider: "pi", account: "" }] });
    await worker.pump();
    worker.preview("/project");
    await worker.pump();
    expect(reads).toContain("pi");
    expect(worker.preview("/project").options.pi.model.text()).toBe("pi-model");
    expect(worker.preview("/project").options.pi.limits).toMatchObject({ windows: [null, { used: 84 }] });
    // Once the command goes, so does the reading.
    reads.length = 0;
    worker.follow(removed);
    await worker.pump();
    expect(reads).not.toContain("pi");
    expect(worker.preview("/project").options.pi.limits).toBe("none");
  } finally {
    await worker.stop();
  }
});
