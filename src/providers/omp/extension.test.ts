import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { source } from "./integration";
import { Agent } from "../../agents";
import { adapter } from "./index";

/** Runs Corgi's extension under a stand-in for omp's extension API; the hooks it sent. */
async function drive(script: string) {
  const root = await mkdtemp(join(tmpdir(), "omp-extension-"));
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
appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),...JSON.parse(text)})+"\\n");
`,
    { mode: 0o755 },
  );
  await writeFile(
    driver,
    `
import extension from ${JSON.stringify(extension)};
import {writeFileSync} from "node:fs";
const hooks = new Map(), entries = [], events = new Map();
const childPath=${JSON.stringify(join(root, "child.jsonl"))};
let name, session="s1";
extension({on:(event,handler)=>hooks.set(event,handler),events:{on:(event,handler)=>{events.set(event,handler);return ()=>events.delete(event)}},getSessionName:()=>name,setSessionName:async n=>{name=n},appendEntry:(type,data)=>entries.push({type,data})});
const publish=(event,data)=>events.get("task:subagent:"+event)?.(data);
const branch=[{type:"message",message:{role:"user",content:[{type:"text",text:"Fix the build"}]}}];
const ctx={mode:"tui",cwd:"/tmp",agent:{kind:"main"},model:{provider:"openai-codex",id:"gpt-6-luna",contextWindow:1000},getContextUsage:()=>({tokens:10}),ui:{onTerminalInput:()=>()=>{}},sessionManager:{getSessionId:()=>session,getSessionFile:()=>"/tmp/s1.jsonl",getBranch:()=>branch}};
const sub={...ctx,agent:{kind:"sub"}};
const emit=(event,e={},c=ctx)=>hooks.get(event)?.(e,c);
${script}
await emit("session_shutdown");
console.log(JSON.stringify(entries));
`,
  );
  const proc = Bun.spawn([process.execPath, driver], {
    env: {
      ...process.env,
      CORGI_OMP_OWNER: "",
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
    const entries = JSON.parse(await new Response(proc.stdout).text());
    const hooks = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(l => JSON.parse(l));
    return { hooks, entries };
  } finally {
    proc.kill();
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  }
}
test("omp reports a turn once its agent yields, and only for the pane's own session", async () => {
  const { hooks, entries } = await drive(`
await emit("session_start");
await emit("before_agent_start", { prompt: "Fix the build" });
await emit("agent_start");
await emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } }, sub);
await emit("tool_execution_start", { toolCallId: "t2", toolName: "edit", args: { path: "a.ts" } });
await emit("tool_execution_end", { toolCallId: "t2", toolName: "edit", isError: false });
await emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
await emit("agent_end", { messages: [], willContinue: true });
await emit("agent_end", { messages: [] }, sub);
await emit("agent_end", { messages: [] });
`);
  expect(hooks.every(h => h.argv.join(" ") === "hook omp")).toBe(true);
  expect(hooks.map(h => h.event)).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ]);
  expect(hooks[1]).toMatchObject({ initial_request: "Fix the build", model: "openai-codex/gpt-6-luna" });
  expect(hooks[3]).toMatchObject({ tool: "edit", input: { path: "a.ts" } });
  expect(hooks[4]).toMatchObject({ outcome: "completed", turn: hooks[1].turn });
  expect(entries.find((e: any) => e.type === "corgi-settled").data).toMatchObject({
    session: "s1",
    turn: hooks[1].turn,
    outcome: "completed",
  });
});
test("omp shows approvals, plan reviews and questions as waiting on the user", async () => {
  const { hooks } = await drive(`
await emit("session_start");
await emit("agent_start");
await emit("tool_approval_requested", { toolName: "bash", toolCallId: "t1" });
await emit("tool_approval_resolved", { toolName: "bash", toolCallId: "t1", approved: true });
await emit("tool_execution_start", { toolCallId: "t2", toolName: "ask", args: {} });
await emit("tool_execution_end", { toolCallId: "t2", toolName: "ask", isError: false });
await emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
await emit("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true });
await emit("plan_review_requested", { reviewId: "r" });
await emit("plan_review_resolved", { reviewId: "r" });
`);
  expect(hooks.map(h => [h.event, h.tool ?? ""])).toEqual([
    ["SessionStart", ""],
    ["UserPromptSubmit", ""],
    ["PermissionRequest", "bash"],
    ["PostToolUse", ""],
    ["PermissionRequest", "ask"],
    ["PostToolUse", ""],
    ["Stop", ""],
    ["PermissionRequest", "plan review"],
    ["Idle", ""],
    ["SessionEnd", ""],
  ]);
});
test.each([false, true])("omp compaction yields to a tool result (isError=%s)", async isError => {
  const { hooks } = await drive(`
await emit("session_start");
await emit("session.compacting");
await emit("session_compact");
await emit("agent_start");
await emit("tool_execution_start", { toolCallId:"t1", toolName:"bash", args:{command:"sleep 1"} });
await emit("session.compacting", {}, sub);
await emit("session.compacting");
await emit("tool_execution_end", { toolCallId:"t1", toolName:"bash", isError:${isError} });
`);
  const agent = new Agent();
  const states: { state: string; compacting: boolean }[] = [];
  for (const [i, hook] of hooks.entries()) {
    agent.observeHook("omp", adapter.hook(hook), BigInt(i + 1), false, i + 1);
    if (hook.event === "PreCompact" || hook.event === "Idle" || hook.event.startsWith("PostToolUse"))
      states.push({ state: agent.state, compacting: agent.compacting });
  }
  expect(states).toEqual([
    { state: "working", compacting: true },
    { state: "idle", compacting: false },
    { state: "working", compacting: true },
    { state: "working", compacting: false },
  ]);
  expect(agent.observation.completed).toBe(0n);
});
test("omp distinguishes a background wait from interruption and starts a fresh turn on wake", async () => {
  const { hooks } = await drive(`
await emit("session_start");
await emit("agent_start");
await emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
await emit("agent_end", { willContinue: true, awaitingAsyncWork: true });
await emit("agent_start");
await emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
await emit("agent_end", { willContinue: true, awaitingAsyncWork: true });
`);
  const stops = hooks.filter(h => h.event === "Stop");
  expect(stops[0]).toMatchObject({ outcome: "completed", awaiting_async_work: true });
  expect(stops[1]).toMatchObject({ outcome: "interrupted", awaiting_async_work: false });
  expect(stops[1].turn).not.toBe(stops[0].turn);
});
test("omp resolves delayed child identity and retains its original parent across a session switch", async () => {
  const { hooks } = await drive(`
await emit("session_start");
const timers=[], schedule=globalThis.setTimeout;
globalThis.setTimeout=fn=>{timers.push(fn);return {unref(){}}};
publish("lifecycle", { id:"ScoutDisplayName", agent:"scout", sessionFile:childPath, status:"started" });
globalThis.setTimeout=schedule;
session="new-parent";
await emit("session_switch");
writeFileSync(childPath, JSON.stringify({type:"session",id:"actual-child"})+"\\n");
timers.shift()();
publish("progress", { sessionFile:childPath, task:"Inspect lifecycle ordering" });
publish("lifecycle", { id:"ScoutDisplayName", agent:"scout", sessionFile:childPath, status:"completed" });
`);
  const children = hooks.filter(h => h.subagent);
  expect(children[0]).toMatchObject({ event: "SubagentStart", session: "s1", subagent: "actual-child" });
  expect(children.at(-1)).toMatchObject({
    event: "SubagentStop",
    session: "s1",
    subagent: "actual-child",
    description: "Inspect lifecycle ordering",
    outcome: "completed",
  });
});
test("omp print-mode children relay nested runner lifecycle without claiming their parent's pane", async () => {
  const { hooks } = await drive(`
ctx.mode="print"; ctx.agent={kind:"sub",id:"Scout",parentId:"Main"};
await emit("session_start");
writeFileSync(childPath, JSON.stringify({type:"session",id:"nested"})+"\\n");
publish("lifecycle", { id:"NestedDisplay", agent:"reviewer", sessionFile:childPath, status:"started" });
publish("lifecycle", { id:"NestedDisplay", agent:"reviewer", sessionFile:childPath, status:"aborted" });
`);
  expect(hooks.map(h => h.event)).toEqual(["SubagentStart", "SubagentStop"]);
  expect(hooks[1]).toMatchObject({ session: "s1", subagent: "nested", outcome: "interrupted" });
});
test("omp reports a child before its lazy transcript has been written", async () => {
  const { hooks } = await drive(`
await emit("session_start");
const childHooks=new Map();
extension({on:(event,handler)=>childHooks.set(event,handler)});
const childCtx={...ctx,mode:"print",agent:{kind:"sub"},sessionManager:{...ctx.sessionManager,getSessionId:()=>"unwritten-child",getSessionFile:()=>childPath}};
await childHooks.get("session_start")({},childCtx);
publish("lifecycle", { id:"DisplayHandle", agent:"scout", sessionFile:childPath, status:"started" });
`);
  expect(hooks.find(h => h.event === "SubagentStart")).toMatchObject({
    session: "s1",
    subagent: "unwritten-child",
    subagent_type: "scout",
  });
});
