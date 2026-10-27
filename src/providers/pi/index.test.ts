import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapter } from "./index";
import { extension, source } from "./integration";
import { entry, open } from "./history";
import * as locations from "./locations";
import { transcript } from "./transcript";
import { Agent, Text } from "../../agents";
import { Provider } from "../../providers";
test("Pi prompt hooks carry bounded initial naming evidence only on prompt events", () => {
  const prompt = adapter.hook({ event: "UserPromptSubmit", session: "s", initial_request: "é".repeat(3000) })!;
  expect(Buffer.byteLength(prompt.initial_request)).toBe(2048);
  expect(prompt.initial_request).not.toContain("�");
  expect(
    adapter.hook({ event: "PreToolUse", session: "s", initial_request: "Ignore this tool output" })?.initial_request,
  ).toBe("");
});

test("Pi launches, resumes and forks without treating trust as tool approval", () => {
  expect(adapter.launch.start({ permissions: "bypass", model: "openai-codex/gpt-6-luna", args: [] })).toEqual([
    "--model",
    "openai-codex/gpt-6-luna",
  ]);
  expect(adapter.launch.resume("id")).toEqual(["--session", "id"]);
  expect(adapter.launch.fork({ session: "id", transcript: "/tmp/a.jsonl", cwd: "/tmp" }, "name")).toMatchObject({
    args: ["--fork", "/tmp/a.jsonl", "--name", "name"],
    named: true,
  });
  expect(Provider.owning("/x/@earendil-works/pi-coding-agent/dist/bundle/cli.js")).toBe("pi");
  expect(adapter.version!("1.0.0")).toBe(true);
  expect(adapter.version!("0.99.0")).toBe(false);
});
test("Pi keeps account and extension settings without replaying prompts or sessions", () => {
  expect(
    adapter.launch.keep!({
      args: [
        "pi",
        "--session",
        "old",
        "--provider",
        "openai-codex",
        "--model",
        "luna",
        "--thinking",
        "low",
        "-e",
        "custom.ts",
        "prompt",
      ],
      env: [],
      flagged: false,
      cwd: "/tmp",
    }).args,
  ).toEqual(["--provider", "openai-codex", "--thinking", "low", "-e", "custom.ts"]);
});
test("Pi extension installation is idempotent and preserves other extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-pi-install-")),
    old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    mkdirSync(join(root, "extensions"));
    writeFileSync(join(root, "extensions", "other.js"), "other");
    expect(extension("install").outcome).toBe("added");
    expect(extension("install").outcome).toBe("present");
    expect(extension("status").outcome).toBe("present");
    expect(readFileSync(join(root, "extensions", "corgi.js"), "utf8")).toBe(source);
    expect(extension("uninstall").outcome).toBe("removed");
    expect(readFileSync(join(root, "extensions", "other.js"), "utf8")).toBe("other");
    writeFileSync(join(root, "extensions", "corgi.js"), "user code");
    expect(extension("install").outcome).toBe("failed");
    expect(extension("uninstall").outcome).toBe("failed");
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
test("Pi history uses header identity and latest display name", () => {
  const lines =
    [
      { type: "session", id: "id", cwd: "/tmp" },
      { type: "message", message: { role: "user", content: "first" } },
      { type: "session_info", name: "My session" },
      { type: "message", message: { role: "assistant", stopReason: "aborted" } },
    ]
      .map(x => JSON.stringify(x))
      .join("\n") + "\n";
  expect(entry(lines, lines)).toMatchObject({
    provider: "pi",
    session: "id",
    title: "My session",
    first: "first",
    interrupted: true,
  });
});
test("Pi completion needs a settlement receipt for the exact session and turn", () => {
  const a = new Agent();
  a.provider = "pi";
  a.session = new Text("s");
  a.setTurn("t");
  const record = { type: "custom", customType: "corgi-settled", data: { session: "s", turn: "t", outcome: "failed" } };
  expect(transcript.completion(a, record)).toBe("failed");
  expect(transcript.completion(a, { ...record, data: { ...record.data, turn: "old" } })).toBeNull();
  expect(transcript.completion(a, { type: "message", message: { role: "assistant", stopReason: "stop" } })).toBeNull();
  expect(() => transcript.verify!({ type: "session", id: "other" }, "s")).toThrow("WrongSession");
});
test("Pi settlement finishes ephemeral sessions, but idle dialogs do not create receipts", () => {
  const a = new Agent({ provider: "pi", session: new Text("s") });
  const apply = (event: string, seq: number, rest = {}) =>
    a.observeHook(
      "pi",
      adapter.hook({ event, session: "s", turn: "t", ...rest })!,
      BigInt(seq),
      false,
      seq,
      "attached",
    );
  apply("UserPromptSubmit", 1);
  apply("Stop", 2, { outcome: "completed" });
  expect(a.state).toBe("idle");
  expect(a.observation.completed).toBe(1n);
  apply("Stop", 3, { outcome: "completed" });
  expect(a.observation.completed).toBe(1n);
  apply("PermissionRequest", 4);
  expect(a.state).toBe("blocked");
  apply("Idle", 5);
  expect(a.state).toBe("idle");
  expect(a.observation.completed).toBe(1n);
});

test("Pi integration creates a fresh configuration before its first launch", () => {
  const parent = mkdtempSync(join(tmpdir(), "corgi-pi-fresh-")),
    root = join(parent, "agent"),
    old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    expect(extension("status").outcome).toBe("no_config");
    expect(extension("install").outcome).toBe("added");
    expect(readFileSync(join(root, "extensions/corgi.js"), "utf8")).toBe(source);
    expect(extension("status").outcome).toBe("present");
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Pi discovers configured and observed custom session directories and resumes by path", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-pi-history-")),
    old = process.env.PI_CODING_AGENT_DIR,
    oldSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "config");
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    const configured = join(root, "configured"),
      custom = join(root, "custom");
    for (const folder of [configured, custom]) mkdirSync(folder);
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ sessionDir: configured }));
    for (const [folder, session] of [
      [configured, "configured-id"],
      [custom, "custom-id"],
    ])
      writeFileSync(
        join(folder, "session.jsonl"),
        [
          { type: "session", id: session, cwd: root },
          { type: "message", message: { role: "user", content: "Remember this session" } },
        ]
          .map(v => JSON.stringify(v))
          .join("\n") + "\n",
      );
    const transcript = join(custom, "session.jsonl");
    adapter.hook({ event: "SessionStart", session: "custom-id", transcript, cwd: root });
    const history = open();
    expect((await history.list(() => false)).sessions.map(e => e.session).sort()).toEqual([
      "configured-id",
      "custom-id",
    ]);
    expect(adapter.launch.resume("custom-id")).toEqual(["--session", transcript]);
    locations.remember("wrong-id", transcript);
    expect((await history.list(() => false)).sessions).toHaveLength(2);
    process.env.PI_CODING_AGENT_SESSION_DIR = custom;
    expect(locations.sessionRoots()).toEqual([custom]);
    rmSync(transcript);
    expect((await history.list(() => false)).sessions).toHaveLength(0);
    history.close();
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    if (oldSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = oldSessions;
    rmSync(root, { recursive: true, force: true });
  }
});
