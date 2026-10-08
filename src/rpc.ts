import { createConnection, type Socket } from "node:net";
import * as json from "./json";
import * as protocol from "./protocol";
export class Connection {
  readonly socket: Socket;
  private pending: {resolve:(value:any)=>void;reject:(error:Error)=>void}[] = [];
  private buffer = "";
  private closed: Error | null = null;
  onEvent?: (value: any) => void;
  constructor(path: string | Socket) {
    this.socket = typeof path === "string" ? createConnection(path) : path;
    this.socket.setEncoding("utf8");
    this.socket.on("data", chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 64 * 1024 * 1024) { this.fail(Error("MessageTooLarge")); this.socket.destroy(); return; }
      for (;;) {
        const newline = this.buffer.indexOf("\n"); if (newline < 0) break;
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try { const message = json.parse(line), pending = this.pending.shift(); if (pending) pending.resolve(message); else this.onEvent?.(message); }
        catch (error) { this.fail(error as Error); }
      }
    });
    this.socket.on("error", error => this.fail(error));
    this.socket.on("close", () => this.fail(Error("ConnectionClosed")));
  }
  private fail(error: Error) { this.closed = error; for (const p of this.pending.splice(0)) p.reject(error); }
  request(op: string | object, fields: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(this.closed);
    const value = typeof op === "string" ? protocol.envelope(op, fields) : op;
    return new Promise((resolve, reject) => { this.pending.push({resolve,reject}); this.socket.write(json.stringify(value) + "\n"); });
  }
  async call(op: string, fields: Record<string, unknown> = {}): Promise<any> { const reply = await this.request(op, fields); if (reply.err) throw Error(reply.err); return reply; }
  close(): void { this.socket.destroy(); }
}
export async function request(path: string, op: string, fields: Record<string, unknown> = {}): Promise<any> {
  const conn = new Connection(path); try { return await conn.call(op,fields); } finally { conn.close(); }
}
