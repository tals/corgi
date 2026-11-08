import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { source } from "./integration";

test("Pi sends opening text before a transcript exists and never sends image data", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-"));
  const extension = join(root, "extension.mjs"),
    sender = join(root, "hook"),
    driver = join(root, "driver.mjs"),
    log = join(root, "hooks.jsonl");
  await writeFile(extension, source);
  await writeFile(
    sender,
    `#!${process.execPath}
import {appendFileSync} from "node:fs";
let text="";for await(const chunk of process.stdin)text+=chunk;
appendFileSync(${JSON.stringify(log)},text+"\\n");
`,
    { mode: 0o755 },
  );
  await writeFile(
    driver,
    `
import extension from ${JSON.stringify(extension)};
const hooks = new Map();
extension({on:(name,handler)=>hooks.set(name,handler),getSessionName:()=>undefined});
const session=crypto.randomUUID();
let branch=[];
const ctx={mode:"tui",cwd:"/tmp",ui:{onTerminalInput:()=>()=>{}},sessionManager:{getSessionId:()=>session,getSessionFile:()=>"/tmp/not-created-"+session,getBranch:()=>branch}};
await hooks.get("session_start")({},ctx);
await hooks.get("before_agent_start")({messageType:"user",prompt:"Fix keyboard shortcuts",images:[{data:"private-image"}]},ctx);
await hooks.get("agent_start")({},ctx);
await hooks.get("session_shutdown")({},ctx);
`,
  );
  const proc = Bun.spawn([process.execPath, driver], {
    env: {
      ...process.env,
      CORGI_PI_OWNER: "",
      CORGI_PANE: "1",
      CORGI_SOCKET: "/tmp/unused",
      CORGI_BIN: sender,
      PI_CODING_AGENT_DIR: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
    const text = await readFile(log, "utf8"),
      events = text
        .trim()
        .split("\n")
        .map(l => JSON.parse(l));
    expect(events.find(e => e.event === "UserPromptSubmit").initial_request).toBe("Fix keyboard shortcuts");
    expect(text).not.toContain("private-image");
  } finally {
    proc.kill();
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  }
});

/** Runs `script` against copies of Corgi's extension, one per session as Pi loads
 * them, beside a stand-in for Pi's SDK; the subagent hooks they sent, and what
 * the script printed. */
async function drive(script: string, env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-"));
  const sdk = join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
    extension = join(root, "extension.mjs"),
    sender = join(root, "hook"),
    driver = join(root, "driver.mjs"),
    log = join(root, "hooks.jsonl");
  await mkdir(sdk, { recursive: true });
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.js" }),
  );
  await writeFile(
    join(sdk, "index.js"),
    `
export class AgentSession {
  constructor({ id, file, parent, name = "", run }) {
    Object.assign(this, { id, file, name, run, listeners: [], model: { provider: "fake", id: "m" } });
    this.sessionManager = { getHeader: () => ({ type: "session", id, parentSession: parent }), getSessionName: () => this.name };
  }
  get sessionId() { return this.id; }
  get sessionFile() { return this.file; }
  subscribe(listener) { this.listeners.push(listener); return () => {}; }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async prompt(text) { await this.run?.(this, text); return "prompted " + text; }
  dispose() {}
}
`,
  );
  await writeFile(extension, source);
  await writeFile(
    sender,
    `#!${process.execPath}
import {appendFileSync} from "node:fs";
let text="";for await(const chunk of process.stdin)text+=chunk;
appendFileSync(${JSON.stringify(log)},text+"\\n");
`,
    { mode: 0o755 },
  );
  await writeFile(
    driver,
    `
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
const root = ${JSON.stringify(root)};
let copies = 0;
// A copy of the extension, as Pi loads one into each session that loads extensions.
const load = async () => {
  const handlers = new Map();
  let name;
  const { default: extension } = await import(${JSON.stringify(extension)} + "?" + copies++);
  extension({ on: (event, handler) => handlers.set(event, handler), getSessionName: () => name, appendEntry: () => {} });
  return { emit: (event, ctx, e = {}) => handlers.get(event)?.(e, ctx), name: n => { name = n; } };
};
const ctx = (id, { mode = "tui", file = root + "/" + id + ".jsonl", parent } = {}) => ({
  mode, cwd: "/tmp", model: { provider: "fake", id: "m" }, ui: { onTerminalInput: () => () => {} },
  sessionManager: { getSessionId: () => id, getSessionFile: () => file, getBranch: () => [], getHeader: () => ({ parentSession: parent }) },
});
// A session that runs one turn, ending as stopReason says.
const work = (stopReason = "stop") => async session => {
  session.emit({ type: "agent_start" });
  session.emit({ type: "message_end", message: { role: "assistant", stopReason } });
  session.emit({ type: "agent_settled", aborted: stopReason === "aborted" });
};
const sent = () => { try { return readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").map(l => JSON.parse(l)); } catch { return []; } };
const until = async predicate => { for (let i = 0; i < 500 && !predicate(sent()); i++) await new Promise(r => setTimeout(r, 10)); };
// The session a Pi process started now would report under.
const parent = () => console.log(JSON.parse(process.env.CORGI_PI_PARENT).session);
${script}
`,
  );
  const proc = Bun.spawn([process.execPath, driver], {
    cwd: root,
    env: {
      ...process.env,
      CORGI_PI_OWNER: "",
      CORGI_PI_PARENT: "",
      CORGI_PANE: "1",
      CORGI_SOCKET: "/tmp/unused",
      CORGI_BIN: sender,
      PI_CODING_AGENT_DIR: root,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
    const text = await readFile(log, "utf8").catch(() => "");
    return {
      root,
      printed: (await new Response(proc.stdout).text()).trim().split("\n").filter(Boolean),
      subagents: text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l))
        .filter(h => h.event.startsWith("Subagent")),
    };
  } finally {
    proc.kill();
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  }
}

test("subagents the pane's turn starts report under the pane's session, labeled by their plugin", async () => {
  const { root, subagents, printed } = await drive(`
const pane = await load();
await pane.emit("session_start", ctx("pane"));
await pane.emit("agent_start", ctx("pane"));
// A child that loads no extensions, made from the SDK extensions import.
const scout = new AgentSession({ id: "scout", file: root + "/scout.jsonl", name: "scout: find stale TODOs", run: async session => {
  session.emit({ type: "agent_start" });
  // Pi processes started during the pane's turn are the pane's, even with a subagent running.
  parent();
  session.emit({ type: "agent_settled" });
} });
await scout.prompt("Task: Find stale TODOs\\nin src/");
// A child that loads extensions reports through its own copy, which the wrapper leaves alone.
const copy = await load(), explore = ctx("explore", { mode: "print" });
copy.name("Explore#ab12cd34");
await copy.emit("session_start", explore);
await new AgentSession({ id: "explore", run: async () => {
  await copy.emit("before_agent_start", explore, { prompt: "Map the build scripts" });
  await copy.emit("agent_start", explore);
  await copy.emit("message_end", explore, { message: { role: "assistant", stopReason: "error" } });
  await copy.emit("agent_settled", explore, { aborted: false });
} }).prompt("Map the build scripts");
await pane.emit("agent_settled", ctx("pane"));
await until(hooks => hooks.filter(h => h.event === "SubagentStop").length === 2);
await copy.emit("session_shutdown", explore);
await pane.emit("session_shutdown", ctx("pane"));
`);
  // Each child's hooks keep their order; two children's may interleave.
  const of = (id: string) => subagents.filter(h => h.subagent === id);
  expect(of("scout").map(h => [h.event, h.session, h.subagent_type, h.subagent_name, h.outcome])).toEqual([
    ["SubagentStart", "pane", "scout", "find stale TODOs", "completed"],
    ["SubagentStop", "pane", "scout", "find stale TODOs", "completed"],
  ]);
  expect(of("explore").map(h => [h.event, h.session, h.subagent_type, h.subagent_name, h.outcome])).toEqual([
    ["SubagentStart", "pane", "Explore", "Map the build scripts", "completed"],
    ["SubagentStop", "pane", "Explore", "Map the build scripts", "failed"],
  ]);
  expect(subagents).toHaveLength(4);
  expect(of("scout")[0]).toMatchObject({
    transcript: join(root, "pane.jsonl"),
    description: "Find stale TODOs",
    child_transcript: join(root, "scout.jsonl"),
    model: "fake/m",
  });
  expect(of("explore")[0].child_transcript).toBe(join(root, "explore.jsonl"));
  expect(printed).toEqual(["pane"]);
});

test("sessions outside the pane's turns aren't subagents unless their header names a known session", async () => {
  const { root, subagents, printed } = await drive(`
const pane = await load();
await pane.emit("session_start", ctx("first"));
// An extension's helper, started from a command while no turn runs.
await new AgentSession({ id: "helper", run: work() }).prompt("Write a commit message");
// The pane moves on; a plugin juggling conversations prompts the old one during the new one's turn.
await pane.emit("session_shutdown", ctx("first"));
const next = await load();
await next.emit("session_start", ctx("second"));
await next.emit("agent_start", ctx("second"));
await new AgentSession({ id: "first", run: work() }).prompt("go on");
await next.emit("agent_settled", ctx("second"));
// A background child that names its parent, disposed mid-turn.
const linked = new AgentSession({ id: "linked", parent: root + "/second.jsonl", run: async s => { s.emit({ type: "agent_start" }); } });
await linked.prompt("Audit the auth flow");
// Pi processes started while it runs alone, with the pane idle, are its.
parent();
linked.dispose();
parent();
await until(hooks => hooks.some(h => h.event === "SubagentStop"));
await next.emit("session_shutdown", ctx("second"));
`);
  expect(subagents.map(h => [h.event, h.session, h.subagent, h.outcome])).toEqual([
    ["SubagentStart", "second", "linked", "completed"],
    ["SubagentStop", "second", "linked", "interrupted"],
  ]);
  expect(subagents[0].transcript).toBe(join(root, "second.jsonl"));
  expect(printed).toEqual(["linked", "second"]);
});

test("a process the pane's Pi started reports its sessions as subagents, nesting their own under them", async () => {
  const { subagents, printed } = await drive(
    `
const copy = await load(), main = ctx("main", { mode: "rpc", file: "/tmp/main.jsonl" });
copy.name("subagent-scout-adcd9149-2554-463b-a95b-b6e0bf1cd7eb-1");
await copy.emit("session_start", main);
await copy.emit("before_agent_start", main, { prompt: "Map the build scripts" });
await copy.emit("agent_start", main);
// Its own subagents, in its process with no extensions or in Pi processes it starts, report under it.
await new AgentSession({ id: "nested", parent: "/tmp/main.jsonl", run: work() }).prompt("Check the tests");
parent();
await copy.emit("message_end", main, { message: { role: "assistant", stopReason: "aborted" } });
await copy.emit("agent_settled", main, { aborted: true });
parent();
await copy.emit("session_shutdown", main);
`,
    {
      CORGI_PI_OWNER: "1",
      CORGI_PI_PARENT: JSON.stringify({
        session: "pane",
        transcript: "/tmp/pane.jsonl",
        cwd: "/tmp",
        account: "/tmp/pi",
      }),
    },
  );
  const of = (id: string) =>
    subagents
      .filter(h => h.subagent === id)
      .map(h => [h.event, h.session, h.subagent_type, h.subagent_name, h.outcome]);
  expect(of("main")).toEqual([
    ["SubagentStart", "pane", "scout", "Map the build scripts", "completed"],
    ["SubagentStop", "pane", "scout", "Map the build scripts", "interrupted"],
  ]);
  expect(of("nested")).toEqual([
    ["SubagentStart", "main", "", "Check the tests", "completed"],
    ["SubagentStop", "main", "", "Check the tests", "completed"],
  ]);
  expect(subagents).toHaveLength(4);
  expect(subagents.find(h => h.subagent === "main")).toMatchObject({
    transcript: "/tmp/pane.jsonl",
    account: "/tmp/pi",
    child_transcript: "/tmp/main.jsonl",
  });
  expect(subagents.find(h => h.subagent === "nested")).toMatchObject({
    transcript: "/tmp/main.jsonl",
    account: "/tmp/pi",
  });
  expect(printed).toEqual(["main", "pane"]);
});
