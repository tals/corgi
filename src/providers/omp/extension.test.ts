import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { source } from "./integration";
import { Agent } from "../../agents";
import { adapter } from "./index";
import { Registry } from "../../conversations";

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
import {writeFileSync,readFileSync,watch} from "node:fs";
const hooks = new Map(), entries = [], events = new Map();
const childPath=${JSON.stringify(join(root, "child.jsonl"))};
let name, session="s1";
extension({on:(event,handler)=>hooks.set(event,handler),events:{on:(event,handler)=>{events.set(event,handler);return ()=>events.delete(event)}},getSessionName:()=>name,setSessionName:async n=>{name=n},appendEntry:(type,data)=>entries.push({type,data})});
const publish=(event,data)=>events.get("task:subagent:"+event)?.(data);
const branch=[{type:"message",message:{role:"user",content:[{type:"text",text:"Fix the build"}]}}];
const ctx={mode:"tui",cwd:"/tmp",agent:{kind:"main"},model:{provider:"openai-codex",id:"gpt-6-luna",contextWindow:1000},getContextUsage:()=>({tokens:10}),ui:{onTerminalInput:()=>()=>{}},sessionManager:{getSessionId:()=>session,getSessionFile:()=>"/tmp/s1.jsonl",getBranch:()=>branch}};
const sub={...ctx,agent:{kind:"sub"}};
const emit=(event,e={},c=ctx)=>hooks.get(event)?.(e,c);
const waitForHook=predicate=>{
  const {promise,resolve}=Promise.withResolvers();
  const check=()=>{
    let sent=[];try{sent=readFileSync(${JSON.stringify(log)},"utf8").trim().split("\\n").map(line=>JSON.parse(line))}catch{}
    if(sent.some(predicate)){watcher.close();resolve()}
  };
  const watcher=watch(${JSON.stringify(root)},check);
  check();
  return promise;
};
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
    return { hooks: hooks.filter(h => h.event !== "Todos"), todos: hooks.filter(h => h.event === "Todos"), entries };
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
await emit("auto_compaction_start");
await emit("auto_compaction_end");
await emit("agent_start");
await emit("tool_execution_start", { toolCallId:"t1", toolName:"bash", args:{command:"sleep 1"} });
await emit("auto_compaction_start", {}, sub);
await emit("auto_compaction_start");
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
test.each([false, true])("omp paired auto-compaction ends clear activity even on failure (failed=%s)", async failed => {
  const { hooks } = await drive(`
await emit("session_start");
await emit("auto_compaction_start");
await emit("auto_compaction_end", {failed:${failed}});
await emit("agent_start");
await emit("auto_compaction_start");
await emit("auto_compaction_end", {failed:${failed}});
`);
  const agent = new Agent(),
    states: { state: string; compacting: boolean }[] = [];
  for (const [i, hook] of hooks.entries()) {
    agent.observeHook("omp", adapter.hook(hook), BigInt(i + 1), false, i + 1);
    if (["PreCompact", "PostCompact", "Idle"].includes(hook.event))
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
test("omp leaves unpaired manual and background compaction signals unobserved", async () => {
  const { hooks } = await drive(`
await emit("session_start");
if (hooks.has("session_before_compact")) throw Error("Background compaction disabled");
await emit("session_before_compact");
await emit("session.compacting");
await emit("session_compact");
await emit("agent_start");
await emit("session.compacting");
await emit("session_compact");
`);
  expect(hooks.map(h => h.event)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);
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

test("omp child metadata follows runner names and late short descriptions", async () => {
  const { hooks } = await drive(`
await emit("session_start");
writeFileSync(childPath, JSON.stringify({type:"session",id:"child-session"})+"\\n");
publish("lifecycle", { id:"ProviderAudit", agent:"reviewer", sessionFile:childPath, status:"started" });
publish("progress", { sessionFile:childPath, assignment:"# Target\\nInspect the provider lifecycle", progress:{id:"ProviderAudit",description:"Audit provider lifecycle"} });
publish("progress", { sessionFile:childPath, assignment:"# Target\\nInspect the provider lifecycle", progress:{id:"ProviderAudit"} });
publish("lifecycle", { id:"ProviderAudit", agent:"reviewer", sessionFile:childPath, status:"completed", description:"Audit shared lifecycle regressions" });
`);
  const registry = new Registry();
  const parent = registry.get("omp", "s1");
  const children = hooks.filter(h => h.subagent);
  const states = children.map((hook, i) => {
    registry.observeHook(parent, adapter.hook!(hook)!, BigInt(i + 1), false, i + 1);
    const child = registry.find("omp", "child-session")!;
    return [child.state.name.text(), child.role.text(), child.state.activity.text(), child.state.state];
  });
  expect(states).toEqual([
    ["ProviderAudit", "reviewer", "", "working"],
    ["ProviderAudit", "reviewer", "Audit provider lifecycle", "working"],
    ["ProviderAudit", "reviewer", "Audit shared lifecycle regressions", "idle"],
  ]);
});

test("omp streams write intent before execution and amends one history checkpoint per call", async () => {
  const { hooks } = await drive(`
await emit("session_start");
await emit("agent_start");
const timers=new Set(), schedule=globalThis.setTimeout, cancel=globalThis.clearTimeout;
globalThis.setTimeout=(fn,ms,...args)=>ms===50?(timers.add(fn),fn):schedule(fn,ms,...args);
globalThis.clearTimeout=timer=>timers.delete(timer)||cancel(timer);
const flushStream=()=>{const pending=[...timers];timers.clear();for(const fn of pending)fn()};
const update=(id,intent,content)=>emit("message_update",{
  message:{role:"assistant",content:[{type:"toolCall",id,name:"write",arguments:{i:intent,path:"new.ts",content}}]},
  assistantMessageEvent:{type:"toolcall_delta",contentIndex:0,delta:"still streaming"}
});
await update("write-1","Writing initial module.","export ");
flushStream();
await waitForHook(h=>h.event==="Activity"&&h.intent==="Writing initial module");
for(let i=0;i<500;i++) await update("write-1","Writing final module   contents.\\n","export "+i);
flushStream();
await waitForHook(h=>h.event==="Activity"&&h.intent==="Writing final module contents");
await update("write-1","Writing final module contents","export const complete=true");
await emit("tool_execution_start",{toolCallId:"write-1",toolName:"write",args:{path:"new.ts",content:"export const complete=true"}});
await emit("tool_execution_end",{toolCallId:"write-1",toolName:"write",isError:false});
await emit("tool_execution_start",{toolCallId:"read-2",toolName:"read",intent:"Inspecting generated module.",args:{path:"new.ts"}});
await emit("tool_execution_end",{toolCallId:"read-2",toolName:"read",isError:false});
await update("write-3","Writing next module","export ");
await emit("tool_execution_start",{toolCallId:"write-3",toolName:"write",intent:"Writing next module",args:{path:"next.ts",content:"export const next=true"}});
await emit("agent_end");
`);
  const activities = hooks.filter(h => h.event === "Activity");
  expect(activities.map(h => [h.intent, h.amend])).toEqual([
    ["Writing initial module", false],
    ["Writing final module contents", true],
    ["Writing next module", false],
  ]);
  const firstExecution = hooks.findIndex(h => h.event === "PreToolUse");
  expect(hooks.indexOf(activities[1])).toBeLessThan(firstExecution);
  expect(hooks[firstExecution]).toMatchObject({ intent: "Writing final module contents", amend: true });
  const registry = new Registry(),
    actor = registry.get("omp", "s1");
  const labels: string[] = [];
  for (const [i, hook] of hooks.entries()) {
    registry.observeHook(actor, adapter.hook!(hook)!, BigInt(i + 1), false, (i + 1) * 1000, "attached");
    if (hook.event === "Activity" || hook.event === "PreToolUse") {
      expect(actor.state.state).toBe("working");
      labels.push(actor.state.activity.text());
    }
  }
  expect(labels).toEqual([
    "Writing initial module",
    "Writing final module contents",
    "Writing final module contents",
    "Inspecting generated module",
    "Writing next module",
    "Writing next module",
  ]);
  expect(actor.activity_timeline.points.slice(0, actor.activity_timeline.len).map(point => point.label.text())).toEqual(
    ["Writing final module contents", "Inspecting generated module", "Writing next module"],
  );
  expect(actor.state.state).toBe("idle");
});

test("omp drains streaming intent before stop, new turn, switch and shutdown without leaking scope", async () => {
  const { hooks } = await drive(`
await emit("session_start");
const update=(id,intent,c=ctx)=>emit("message_update",{
  message:{role:"assistant",content:[{type:"toolCall",id,name:"write",arguments:{i:intent,content:"partial"}}]},
  assistantMessageEvent:{type:"toolcall_delta",contentIndex:0,delta:"partial"}
},c);
await update("idle","Ignored idle intent");
await emit("agent_start");
await update("sub","Ignored child intent",sub);
await update("print","Ignored print intent",{...ctx,mode:"print"});
await update("old","Writing old turn");
const stopping=emit("agent_end");
await update("stopped","Ignored stopped intent");
const waking=emit("agent_start");
await update("old","Writing awakened turn");
await Promise.all([stopping,waking]);
const oldCtx={...ctx,sessionManager:{...ctx.sessionManager,getSessionId:()=>"s1"}};
session="s2";
await emit("session_switch");
await update("switched","Ignored switched idle intent");
await emit("agent_start");
await update("stale","Ignored stale session intent",oldCtx);
await update("old","Writing new session");
`);
  const events = hooks.map(h => [h.event, h.session]);
  expect(events).toEqual([
    ["SessionStart", "s1"],
    ["UserPromptSubmit", "s1"],
    ["Activity", "s1"],
    ["Stop", "s1"],
    ["UserPromptSubmit", "s1"],
    ["Activity", "s1"],
    ["SessionStart", "s2"],
    ["UserPromptSubmit", "s2"],
    ["Activity", "s2"],
    ["SessionEnd", "s2"],
  ]);
  const activities = hooks.filter(h => h.event === "Activity");
  expect(activities.map(h => [h.intent, h.amend])).toEqual([
    ["Writing old turn", false],
    ["Writing awakened turn", false],
    ["Writing new session", false],
  ]);
  expect(activities[0].turn).toBe(hooks[1].turn);
  expect(activities[1].turn).toBe(hooks[4].turn);
  expect(activities[0].turn).not.toBe(activities[1].turn);
  expect(activities[2].turn).toBe(hooks[7].turn);
  const registry = new Registry();
  for (const [i, hook] of hooks.entries()) {
    const actor = registry.get("omp", hook.session);
    registry.observeHook(actor, adapter.hook!(hook)!, BigInt(i + 1), false, (i + 1) * 1000, "attached");
    if (hook.event === "Stop" || hook.event === "SessionEnd") expect(actor.state.state).toBe("idle");
    if (hook.event === "Activity") expect(actor.state.activity.text()).toBe(hook.intent);
  }
  const actor = registry.find("omp", "s2")!;
  expect(actor.activity_timeline.points.slice(0, actor.activity_timeline.len).map(point => point.label.text())).toEqual(
    ["Writing new session"],
  );
});

test("omp child activity prefers native runner intents and retains task description fallback", async () => {
  const { hooks } = await drive(`
await emit("session_start");
writeFileSync(childPath, JSON.stringify({type:"session",id:"native-child"})+"\\n");
publish("lifecycle",{id:"Writer",agent:"task",sessionFile:childPath,status:"started",description:"Implement module"});
publish("progress",{sessionFile:childPath,progress:{description:"Implement module",currentToolIntent:"Writing child module",lastIntent:"Reading child source"}});
publish("progress",{sessionFile:childPath,progress:{description:"Implement module",lastIntent:"Checking child module"}});
publish("progress",{sessionFile:childPath,progress:{description:"Implement module"}});
`);
  const registry = new Registry(),
    parent = registry.get("omp", "s1");
  const labels = hooks
    .filter(h => h.subagent)
    .map((hook, i) => {
      registry.observeHook(parent, adapter.hook!(hook)!, BigInt(i + 1), false, (i + 1) * 1000);
      return registry.find("omp", "native-child")!.state.activity.text();
    });
  expect(labels).toEqual(["Implement module", "Writing child module", "Checking child module", "Implement module"]);
});

test("omp reports branch TODO state, successful edits and explicit clears without leaking child sessions", async () => {
  const { todos } = await drive(`
const phases=[{name:"Implementation",tasks:[{content:"Ship it",status:"in_progress"}]}];
branch.push({type:"custom",customType:"user_todo_edit",timestamp:"2026-10-27T12:00:00.000Z",data:{phases}});
await emit("session_start");
await emit("agent_start");
await emit("tool_execution_end", {toolName:"todo",isError:false,result:{details:{op:"update",phases:[{name:"Done",tasks:[{content:"Ship it",status:"completed"}]}]}}});
await emit("tool_execution_end", {toolName:"todo",isError:true,result:{details:{op:"update",phases:[]}}});
await emit("tool_execution_end", {toolName:"todo",isError:false,result:{details:{op:"view",phases:[]}}});
await emit("tool_execution_end", {toolName:"todo",isError:false,result:{details:{op:"clear",phases:[]}}},sub);
await emit("tool_execution_end", {toolName:"todo",isError:false,result:{details:{op:"clear",phases:[]}}});
session="s2";branch.length=0;
branch.push({type:"message",timestamp:"2026-10-27T12:05:00.000Z",message:{role:"toolResult",toolName:"todo",isError:false,details:{op:"update",phases}}});
await emit("session_switch");
session="s3";branch.length=0;
await emit("session_switch");
`);
  // Lists read back from the session keep their entry's time; edits arrive as they happen.
  expect(todos.map(h => [h.session, h.at, h.todos.phases])).toEqual([
    [
      "s1",
      Date.parse("2026-10-27T12:00:00.000Z"),
      [{ name: "Implementation", tasks: [{ content: "Ship it", status: "in_progress" }] }],
    ],
    ["s1", undefined, [{ name: "Done", tasks: [{ content: "Ship it", status: "completed" }] }]],
    ["s1", undefined, []],
    [
      "s2",
      Date.parse("2026-10-27T12:05:00.000Z"),
      [{ name: "Implementation", tasks: [{ content: "Ship it", status: "in_progress" }] }],
    ],
    ["s3", undefined, []],
  ]);
});
