/** Provider processes and read-only Codex observer used by integration tests. */
import { createServer, type Socket, type Server } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const shebang = `#!${process.execPath}\n`;
export const NATIVE_PROVIDER = `${shebang}
const claude = process.argv.includes('--print');
if (process.argv.includes('--version')) { console.log('codex-cli 1.2.3-fixture'); process.exit(0); }
const emit = (v) => console.log(JSON.stringify(v));
let turnNumber = 0, activeTurn = null, lastTurn = null;
function ensureTurn() {
  if (activeTurn === null) { turnNumber++; activeTurn = turnNumber === 1 ? 'turn' : 'turn-' + turnNumber; lastTurn = activeTurn;
    if (!claude) emit({method:'turn/started',params:{threadId:'t',turn:{id:activeTurn}}}); }
  return activeTurn;
}
function finishTurn(result) {
  emit(claude ? {type:'result',result} : {method:'turn/completed',params:{threadId:'t',turn:{id:activeTurn || lastTurn,status:'completed'}}});
  activeTurn = null;
}
for await (const line of (await import('node:readline')).createInterface({input:process.stdin})) {
  if (!line.trim()) continue;
  const v = JSON.parse(line);
  if (v.method === 'initialize') emit({id:v.id,result:{version:'fixture'}});
  else if (v.method === 'initialized') emit({method:'ready'});
  else if (v.method === 'test/approval') { ensureTurn(); emit(claude ? {type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Bash'}} : {id:900,method:'item/commandExecution/requestApproval',params:{threadId:'t'}}); }
  else if (v.method === 'test/flood') for(let i=0;i<150;i++) emit({type:'fixture',n:i});
  else if (v.method === 'test/tool-start') { ensureTurn(); const id=v.params.id; emit(claude ? {type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{}}]}} : {method:'item/started',params:{threadId:'t',turnId:activeTurn,item:{id,type:'commandExecution'}}}); }
  else if (v.method === 'test/tool-stop') { const id=v.params.id; emit(claude ? {type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:'done'}]}} : {method:'item/completed',params:{threadId:'t',turnId:activeTurn,item:{id,type:'commandExecution'}}}); }
  else if (v.method === 'test/turn-end') finishTurn('done');
  else if (v.id === 900 || v.type === 'control_response') finishTurn('complete');
  else if (v.method === 'test/event') emit(v.params);
  else if (v.method === 'test/exit') process.exit(0);
  else if ('id' in v) emit({id:v.id,result:{echo:v}});
}
`;

export const ORDINARY_PROVIDER = `${shebang}
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const provider=basename(process.argv[1]);
const path=provider==='codex' ? join(process.env.CODEX_HOME,'hooks.json') : join(process.env.CLAUDE_CONFIG_DIR,'settings.json');
const transcript=join(process.env.HOME,'ordinary-'+provider+'.jsonl');
writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:'ordinary-'+provider}})+'\\n');
let turn=0;
function event(name) {
  if (!existsSync(path)) return;
  if (name==='UserPromptSubmit') turn++;
  for (const group of JSON.parse(readFileSync(path,'utf8')).hooks?.[name] || []) for (const hook of group.hooks) {
    spawnSync('/bin/sh',['-c',hook.command],{input:JSON.stringify({hook_event_name:name,session_id:'ordinary-'+provider,turn_id:String(turn),transcript_path:transcript}),encoding:'utf8'});
  }
  if(name==='Stop') {
    const stamp=new Date().toISOString();
    const record=provider==='codex' ? {type:'event_msg',timestamp:stamp,payload:{type:'task_complete',turn_id:String(turn)}} : {type:'system',subtype:'turn_duration',sessionId:'ordinary-'+provider,timestamp:stamp};
    appendFileSync(transcript,JSON.stringify(record)+'\\n');
  }
}
let loading=process.argv.includes('--loading');
if(loading) console.log('\\x1b[2J\\x1b[H\\x1b]2;⠋ Starting\\x07Initializing (esc to interrupt)');
else { event('SessionStart'); console.log('\\x1b[2J\\x1b[H\\x1b]2;✳ Ready\\x07› '); }
for await(const line of (await import('node:readline')).createInterface({input:process.stdin})) {
  const command=line.trim();
  if(loading) { if(command==='ready') { loading=false; event('SessionStart'); console.log('\\x1b[2J\\x1b[H\\x1b]2;✳ Ready\\x07› '); } continue; }
  if(command==='exit') break;
  if(command==='work') { event('UserPromptSubmit'); console.log('\\x1b[2J\\x1b[H\\x1b]2;⠋ Task\\x07Working (esc to interrupt)'); }
  else if(command==='tool') console.log('\\x1b[2J\\x1b[H• Working (20s • esc to interrupt) · 1 background t…\\n› Ask Codex to do anything');
  else if(command==='block') { event('PermissionRequest'); console.log('\\x1b[2J\\x1b[H\\x1b]2;Action Required\\x07enter to confirm or esc to cancel'); }
  else if(command==='stop') { event('Stop'); console.log('\\x1b[2J\\x1b[H\\x1b]2;✳ Ready\\x07› '); }
}
if(!loading) event('SessionEnd');
process.exit(0);
`;

export function write_executable(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source.replace(/^#![^\n]*\n/, shebang));
  chmodSync(path, 0o700);
  return path;
}
export const write_ordinary_agent = (path: string) =>
  write_executable(path, ORDINARY_PROVIDER);
export function write_codex_terminal(path: string, session: string) {
  return write_executable(
    path,
    `${shebang}
console.log('ARGS:'+JSON.stringify(process.argv.slice(2)).replaceAll(',',', '));
const title=(s)=>process.stdout.write('\\x1b]0;codex | '+s+'\\x07');
title(${JSON.stringify(session.slice(0, 29) + "...")});
for await(const line of (await import('node:readline')).createInterface({input:process.stdin})) {
  const v=line.trim(); if(v==='exit') break;
  if(v.startsWith('screen:')) { const screen={'screen:working':'Working (esc to interrupt)','screen:compacting':'• Compacting context (2s • esc to interrupt)'}[v] || '› '; console.log('\\x1b[2J\\x1b[H'+screen); }
  else title(v);
}
process.exit(0);
`,
  );
}

export class TerminalAttachment {
  constructor(
    public runtime: any,
    public pane: number,
  ) {}
  async send(value: string) {
    return this.runtime.command("pane.input", {
      target: this.pane,
      data: value + "\r",
    });
  }
  async select(session: string, abbreviate = true) {
    return this.send(abbreviate ? session.slice(0, 29) + "..." : session);
  }
  async state() {
    return (await this.runtime.panes()).find((p: any) => p.id === this.pane);
  }
}

export function frame(value: any): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  let size: Buffer;
  if (data.length < 126) size = Buffer.from([data.length]);
  else if (data.length <= 65535) {
    size = Buffer.alloc(3);
    size[0] = 126;
    size.writeUInt16BE(data.length, 1);
  } else {
    size = Buffer.alloc(9);
    size[0] = 127;
    size.writeBigUInt64BE(BigInt(data.length), 1);
  }
  return Buffer.concat([Buffer.from([0x81]), size, data]);
}
class FrameReader {
  buffer = Buffer.alloc(0);
  pending: ((v: any) => void)[] = [];
  failure: ((e: any) => void)[] = [];
  queue: any[] = [];
  constructor(public socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.parse();
    });
    socket.on("error", (e) => this.reject(e));
    socket.on("close", () => this.reject(new Error("socket closed")));
  }
  parse() {
    while (this.buffer.length >= 2) {
      let offset = 2,
        length = this.buffer[1] & 127;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = !!(this.buffer[1] & 128);
      if (this.buffer.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const data = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      const value = JSON.parse(data.toString());
      const done = this.pending.shift();
      this.failure.shift();
      if (done) done(value);
      else this.queue.push(value);
    }
  }
  receive(): Promise<any> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      this.pending.push(resolve);
      this.failure.push(reject);
    });
  }
  reject(e: any) {
    for (const fail of this.failure.splice(0)) fail(e);
    this.pending.length = 0;
  }
}
export class HeldResponse {
  request: any = null;
  response: any = null;
  captured = false;
  released = false;
  private captureWaiters: ((v: HeldResponse) => void)[] = [];
  private releaseWaiters: (() => void)[] = [];
  constructor(
    public method: string,
    public session: string | null = null,
  ) {}
  matches(request: any) {
    return (
      request.method === this.method &&
      (this.session === null || request.params?.threadId === this.session)
    );
  }
  capture(request: any, response: any) {
    this.request = request;
    this.response = structuredClone(response);
    this.captured = true;
    this.captureWaiters.splice(0).forEach((f) => f(this));
  }
  async wait(timeout = 4): Promise<HeldResponse> {
    if (this.captured) return this;
    return Promise.race([
      new Promise<HeldResponse>((resolve) => this.captureWaiters.push(resolve)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("provider did not request held " + this.method)),
          timeout * 1000,
        ),
      ),
    ]);
  }
  async waitRelease() {
    if (this.released) return;
    await new Promise<void>((resolve) => this.releaseWaiters.push(resolve));
  }
  release() {
    this.released = true;
    this.releaseWaiters.splice(0).forEach((f) => f());
  }
}
export class CodexObserver {
  ids: string[];
  states: Record<string, string> = {};
  turns: Record<string, [string, string]> = {};
  items: Record<string, any[]> = {};
  paths: Record<string, string> = {};
  names: Record<string, string> = {};
  children: any[] = [];
  wait_items: any[] = [];
  waiting: boolean | Record<string, boolean> = false;
  child_error = false;
  errors: string[] = [];
  methods: string[] = [];
  requests: any[] = [];
  background_tasks: Record<string, any[]> = {};
  path: string;
  server: Server;
  peers = new Set<Socket>();
  holds: HeldResponse[] = [];
  gates: HeldResponse[] = [];
  closed = false;
  constructor(codexHome: string, sessions: string[]) {
    this.ids = [...sessions];
    this.ids.forEach((id, i) => {
      this.states[id] = "idle";
      this.turns[id] = ["old-" + i, "completed"];
    });
    this.path = join(
      codexHome,
      "app-server-control",
      "app-server-control.sock",
    );
    mkdirSync(dirname(this.path), { recursive: true });
    this.server = createServer((peer) => this.servePeer(peer));
    this.server.listen(this.path);
  }
  set_turn(
    session: string,
    turn: string,
    status: string,
    options: { waiting?: boolean; items?: any[] } = {},
  ) {
    if (!this.ids.includes(session)) this.ids.push(session);
    this.states[session] = status === "inProgress" ? "active" : "idle";
    this.turns[session] = [turn, status];
    if (typeof this.waiting === "boolean")
      this.waiting = Object.fromEntries(
        this.ids.map((id) => [id, this.waiting as boolean]),
      );
    this.waiting[session] = options.waiting ?? false;
    if (options.items !== undefined) this.items[session] = options.items;
  }
  hold(method: string, session: string | null = null) {
    const gate = new HeldResponse(method, session);
    this.holds.push(gate);
    this.gates.push(gate);
    return gate;
  }
  hold_turn(session: string, turn: string, status: string, options: any = {}) {
    this.set_turn(session, turn, status, options);
    return this.hold("thread/turns/list", session);
  }
  async wait_for_request(
    method: string,
    {
      session = null,
      after = 0,
      timeout = 4,
    }: { session?: string | null; after?: number; timeout?: number } = {},
  ) {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      for (let i = after; i < this.requests.length; i++)
        if (
          this.requests[i].method === method &&
          (session === null || this.requests[i].params?.threadId === session)
        )
          return i + 1;
      await Bun.sleep(10);
    }
    throw new Error("provider did not request " + method);
  }
  async close() {
    this.closed = true;
    this.gates.forEach((g) => g.release());
    this.peers.forEach((p) => p.destroy());
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      unlinkSync(this.path);
    } catch {}
  }
  async servePeer(peer: Socket) {
    this.peers.add(peer);
    let handshake = Buffer.alloc(0);
    let reader: FrameReader | null = null;
    const onData = (chunk: Buffer) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end < 0) return;
      peer.off("data", onData);
      const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(
        handshake.toString(),
      )?.[1];
      if (!key) {
        peer.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      peer.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      reader = new FrameReader(peer);
      const rest = handshake.subarray(end + 4);
      if (rest.length) {
        reader.buffer = rest;
        reader.parse();
      }
      void this.processPeer(peer, reader);
    };
    peer.on("data", onData);
    peer.on("close", () => this.peers.delete(peer));
  }
  async processPeer(peer: Socket, reader: FrameReader) {
    try {
      while (!this.closed) {
        const request = await reader.receive();
        this.methods.push(request.method);
        this.requests.push(request);
        if (request.method === "initialized") continue;
        const response = this.response(request);
        const data = frame(response);
        const gate = this.holds.find((g) => g.matches(request));
        if (gate) {
          this.holds.splice(this.holds.indexOf(gate), 1);
          gate.capture(request, response);
          await gate.waitRelease();
        }
        if (this.closed) return;
        peer.write(data.subarray(0, 3));
        peer.write(data.subarray(3));
      }
    } catch (e) {
      if (!this.closed && !peer.destroyed) this.errors.push(String(e));
    } finally {
      peer.destroy();
    }
  }
  response(request: any) {
    const method = request.method,
      p = request.params || {};
    let result: any;
    if (method === "initialize") result = {};
    else if (method === "thread/loaded/list")
      result = { data: this.ids, nextCursor: null };
    else if (method === "thread/read") {
      const s = p.threadId,
        w = typeof this.waiting === "boolean" ? this.waiting : this.waiting[s];
      result = {
        thread: {
          id: s,
          name: this.names[s] || "",
          path: this.paths[s] || "",
          status: {
            type: this.states[s],
            activeFlags: w ? ["waitingOnUserInput"] : [],
          },
        },
      };
    } else if (method === "thread/turns/list") {
      const s = p.threadId,
        [turn, status] = this.turns[s];
      result = {
        data: [{ id: turn, status, items: this.items[s] || [] }],
        nextCursor: null,
      };
    } else if (method === "thread/backgroundTerminals/list")
      result = {
        data: this.background_tasks[p.threadId] || [],
        nextCursor: null,
      };
    else if (method === "thread/list") {
      if (JSON.stringify(p.sourceKinds) !== '["subAgent"]' || !p.useStateDbOnly)
        throw new Error("observer must request only subagents from state DB");
      const offset = Number(p.cursor || 0);
      if (offset && this.child_error)
        return {
          id: request.id,
          error: { code: -32603, message: "fixture page failed" },
        };
      result = {
        data: this.children.slice(offset, offset + 2),
        nextCursor:
          offset + 2 < this.children.length ? String(offset + 2) : null,
      };
    } else if (method === "thread/items/list") {
      if (p.sortDirection !== "desc")
        throw new Error("observer must request items newest first");
      const offset = Number(p.cursor || 0);
      result = {
        data: this.wait_items.slice(offset, offset + 2),
        nextCursor:
          offset + 2 < this.wait_items.length ? String(offset + 2) : null,
      };
    } else throw new Error("mutating or unexpected RPC " + method);
    return { id: request.id, result };
  }
}
