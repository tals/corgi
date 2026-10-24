import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { adapter } from "./index";
import { extension, source } from "./integration";
import { entry, open } from "./history";
import { transcript } from "./transcript";
import { identity } from "./accounts";
import { applyUsage, report } from "./account";
import { Info } from "../../usage/account";
import { Text } from "../../agents";
import { Counts } from "../../usage/tokens";
/** Runs `run` to its end with `root` as omp's agent folder. */
async function withAgentDir<T>(root: string, run: () => T | Promise<T>): Promise<T> {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    return await run();
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}
test("omp launches, resumes and forks with its own flags", () => {
  expect(adapter.launch.start({ permissions: "bypass", model: "openai-codex/gpt-6-luna", args: [] })).toEqual([
    "--auto-approve",
    "--model",
    "openai-codex/gpt-6-luna",
  ]);
  expect(adapter.launch.resume("unseen-id")).toEqual(["--resume", "unseen-id"]);
  expect(adapter.launch.fork({ session: "id", transcript: "/tmp/a.jsonl", cwd: "/tmp" }, "name")).toEqual({
    args: ["--fork", "/tmp/a.jsonl"],
    session: null,
    named: false,
  });
  expect(adapter.owns("/x/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(true);
  expect(adapter.owns("/x/node_modules/@earendil-works/pi-coding-agent/dist/cli.js")).toBe(false);
  expect(adapter.version!("omp/18.12.6\n")).toBe(true);
  expect(adapter.version!("1.2.0")).toBe(false);
});
test("omp keeps account and extension options without replaying sessions or prompts", () => {
  const c = (args: string[]) => ({ args: ["omp", ...args], env: [], flagged: false, cwd: "/tmp" });
  expect(
    adapter.launch.keep!(
      c(["--resume", "old", "--model", "luna", "--thinking", "low", "-e", "x.ts", "--auto-approve", "prompt"]),
    ).args,
  ).toEqual(["--thinking", "low", "-e", "x.ts", "--auto-approve"]);
  expect(adapter.inspect(c(["--auto-approve"])).permissions).toBe("bypass");
  expect(adapter.inspect(c(["--approval-mode", "yolo"])).permissions).toBe("bypass");
  expect(adapter.inspect(c(["--approval-mode", "write"])).permissions).toBe("default");
  expect(adapter.inspect(c(["--provider", "anthropic", "--model", "opus"])).model).toBe("anthropic/opus");
});
test("omp extension installs into omp's own agent folder", async () => {
  const parent = mkdtempSync(join(tmpdir(), "corgi-omp-install-")),
    root = join(parent, "agent");
  try {
    await withAgentDir(root, () => {
      expect(extension("status").outcome).toBe("no_config");
      expect(extension("install").outcome).toBe("added");
      expect(extension("install").outcome).toBe("present");
      expect(readFileSync(join(root, "extensions", "corgi.js"), "utf8")).toBe(source);
      writeFileSync(join(root, "extensions", "other.js"), "other");
      expect(extension("uninstall").outcome).toBe("removed");
      expect(readFileSync(join(root, "extensions", "other.js"), "utf8")).toBe("other");
      writeFileSync(join(root, "extensions", "corgi.js"), "user code");
      expect(extension("install").outcome).toBe("failed");
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
const session = (records: object[]) => records.map(x => JSON.stringify(x)).join("\n") + "\n";
test("omp history reads the header after the title slot and the latest title", () => {
  const lines = session([
    { type: "title", v: 1, title: "First title", pad: "   " },
    { type: "session", version: 3, id: "id", cwd: "/tmp" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "title_change", title: "Renamed", source: "user" },
    { type: "message", message: { role: "assistant", stopReason: "aborted" } },
  ]);
  expect(entry(lines, lines)).toMatchObject({
    provider: "omp",
    session: "id",
    title: "Renamed",
    first: "first",
    interrupted: true,
  });
  expect(entry(session([{ type: "title", title: "" }]), "")).toBeNull();
});
test("omp transcripts name the session and its model, and skip the title slot when verifying", () => {
  expect(() => transcript.verify!({ type: "title", title: "" }, "s")).not.toThrow();
  expect(() => transcript.verify!({ type: "session", id: "other" }, "s")).toThrow("WrongSession");
  const reader = transcript.reader(() => []);
  const t = { name: new Text(), model: null } as any;
  expect(reader.record(t, {} as any, { type: "title_change", title: "Fix the build" }, true, null)).toBeInstanceOf(
    Counts,
  );
  reader.record(t, {} as any, { type: "model_change", model: "openai-codex/gpt-5.6-luna" }, true, null);
  expect([t.name.text(), t.model.label()]).toEqual(["Fix the build", "GPT-5.6 Luna"]);
});
test("omp history lists sessions one folder deep, not its subagents'", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-omp-history-"));
  try {
    const folder = join(root, "sessions", "-tmp");
    mkdirSync(join(folder, "subagents"), { recursive: true });
    const write = (path: string, id: string) =>
      writeFileSync(
        path,
        session([
          { type: "title", title: "" },
          { type: "session", id, cwd: root },
          { type: "message", message: { role: "user", content: "hello" } },
        ]),
      );
    write(join(folder, "2026_main.jsonl"), "main");
    write(join(folder, "subagents", "task.jsonl"), "task");
    await withAgentDir(root, async () => {
      const history = open();
      expect((await history.list(() => false)).sessions.map(e => e.session)).toEqual(["main"]);
      history.close();
      adapter.hook({ event: "SessionStart", session: "main", transcript: join(folder, "2026_main.jsonl"), cwd: root });
      expect(adapter.launch.resume("main")).toEqual(["--resume", join(folder, "2026_main.jsonl")]);
      // A --session-dir outside the agent folder is found once the extension reports it.
      mkdirSync(join(root, "custom sessions"));
      const custom = join(root, "custom sessions", "2026_custom.jsonl");
      write(custom, "custom");
      adapter.hook({ event: "SessionStart", session: "custom", transcript: custom, cwd: root, account: root });
      const again = open();
      expect((await again.list(() => false)).sessions.map(e => e.session).sort()).toEqual(["custom", "main"]);
      again.close();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("omp identity follows the default model's provider in its credential database", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-omp-accounts-"));
  try {
    expect(identity(root)).toBeNull();
    const db = new Database(join(root, "agent.db"));
    db.run(
      "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL)",
    );
    const add = db.prepare(
      "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key) VALUES (?, ?, ?, ?, ?)",
    );
    add.run("anthropic", "api_key", JSON.stringify({ key: "sk-1" }), null, null);
    add.run("openai-codex", "oauth", JSON.stringify({ email: "old@x.dev", accountId: "a0" }), "revoked", "u0");
    add.run("openai-codex", "oauth", JSON.stringify({ email: "me@x.dev", accountId: "a1" }), null, "u1");
    db.close();
    expect(identity(root)?.email).toBe("anthropic API key");
    writeFileSync(join(root, "config.yml"), "modelRoles:\n  default: openai-codex/gpt-6.1-sol\n");
    expect(identity(root)).toEqual({ email: "me@x.dev", id: "openai-codex:u1/a1" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("omp usage shows the shortest and longest limit windows of the signed-in account", () => {
  const limit = (ms: number, used: number) => ({
    window: { durationMs: ms, resetsAt: 1_800_000_000_000 },
    amount: { usedFraction: used },
  });
  const value = {
    reports: [
      { provider: "openai-codex", metadata: { accountId: "other" }, limits: [limit(18_000_000, 0.9)] },
      {
        provider: "openai-codex",
        metadata: { accountId: "a1", planType: "promax" },
        limits: [limit(604_800_000, 0.01), limit(18_000_000, 0.25)],
      },
    ],
  };
  const info = new Info();
  applyUsage(info, report(value, "openai-codex", "a1"), "openai-codex");
  expect(info.limits).toMatchObject({
    windows: [
      { minutes: 300, used: 25, reset_at: 1_800_000_000 },
      { minutes: 10080, used: 1 },
    ],
  });
  expect(info.plan.text()).toBe("Pro 500");
  expect(() => applyUsage(new Info(), { limits: [] }, "openai-codex")).toThrow("UsageUnavailable");
});
