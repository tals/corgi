import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { Control } from "./control";
import { Quit } from "../../subprocess";
function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "corgi-control-review-")),
    exe = join(root, "claude");
  writeFileSync(
    exe,
    `#!${process.execPath}\nlet input='';process.stdin.on('data',b=>{input+=b;let i;while((i=input.indexOf('\\n'))>=0){const v=JSON.parse(input.slice(0,i));input=input.slice(i+1);const method=v.request.subtype;if(method==='initialize')process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:v.request_id,subtype:'success',response:{}}})+'\\n');else if(${JSON.stringify(mode)}==='approval')process.stdout.write(JSON.stringify({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool'}})+'\\n');else if(${JSON.stringify(mode)}==='overflow')process.stdout.write('x'.repeat(4*1024*1024+1));else if(${JSON.stringify(mode)}==='invalid-subtype')process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:v.request_id,subtype:'other',response:{}}})+'\\n');}});\n`,
    { mode: 0o700 },
  );
  const c = new Control(exe);
  return {
    c,
    async close() {
      const child = c.child;
      c.close();
      if (child && child.exitCode === null && child.signalCode === null) await once(child, "exit");
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("control never inherits another session's nesting markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-control-env-")),
    exe = join(root, "claude");
  // Answers initialize with the nesting markers and a user setting it sees.
  writeFileSync(
    exe,
    `#!${process.execPath}\nlet input='';process.stdin.on('data',b=>{input+=b;let i;while((i=input.indexOf('\\n'))>=0){const v=JSON.parse(input.slice(0,i));input=input.slice(i+1);const e=process.env;process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:v.request_id,subtype:'success',response:{nested:[e.CLAUDECODE,e.CLAUDE_CODE_CHILD_SESSION,e.CLAUDE_CODE_MESSAGING_SOCKET,e.CLAUDE_PID].filter(Boolean),kept:e.CORGI_TEST_KEEP??null}}})+'\\n');}});\n`,
    { mode: 0o700 },
  );
  const c = new Control(exe, {
    ...process.env,
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc.sock",
    CLAUDE_PID: "53013",
    CORGI_TEST_KEEP: "kept",
  });
  try {
    expect(await c.ready()).toEqual({ nested: [], kept: "kept" });
  } finally {
    const child = c.child;
    c.close();
    if (child && child.exitCode === null && child.signalCode === null) await once(child, "exit");
    rmSync(root, { recursive: true, force: true });
  }
});
test("read-only control rejects unexpected provider requests", async () => {
  const f = fixture("approval");
  try {
    await expect(f.c.request("get_usage")).rejects.toThrow("UnexpectedRequest");
  } finally {
    await f.close();
  }
});
test("control messages retain the native four MiB limit", async () => {
  const f = fixture("overflow");
  try {
    await expect(f.c.request("get_usage")).rejects.toThrow("HeadlessMessageTooLarge");
  } finally {
    await f.close();
  }
});
test("control rejects every non-success response subtype", async () => {
  const f = fixture("invalid-subtype");
  try {
    await expect(f.c.request("get_usage")).rejects.toThrow("UnsupportedUsage");
  } finally {
    await f.close();
  }
});
test("control quit cancels an in-flight metadata request", async () => {
  const f = fixture("waiting"),
    quit = new Quit();
  try {
    const request = f.c.request("get_usage", {}, { quit });
    setTimeout(() => quit.signal(), 50);
    await expect(request).rejects.toThrow("Cancelled");
    expect(f.c.pending.size).toBe(0);
  } finally {
    await f.close();
  }
});
test("control observes shared stopping while a request waits", async () => {
  const f = fixture("waiting"),
    stopping = { value: false };
  try {
    const request = f.c.request("get_usage", {}, { stopping });
    setTimeout(() => (stopping.value = true), 50);
    await expect(request).rejects.toThrow("Cancelled");
  } finally {
    await f.close();
  }
});
