import { createConnection, type Socket } from "node:net";
import * as json from "./json";
import * as protocol from "./protocol";
export class Connection {
  readonly socket: Socket;
  private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  private buffer = "";
  private closed: Error | null = null;
  onEvent?: (value: unknown) => void;
  constructor(path: string | Socket) {
    this.socket = typeof path === "string" ? createConnection(path) : path;
    this.socket.setEncoding("utf8");
    this.socket.on("data", chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 64 * 1024 * 1024) {
        this.fail(Error("MessageTooLarge"));
        this.socket.destroy();
        return;
      }
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = json.parse(line),
            pending = this.pending.shift();
          if (pending) pending.resolve(message);
          else this.onEvent?.(message);
        } catch (error) {
          this.fail(error as Error);
        }
      }
    });
    this.socket.on("error", error => this.fail(error));
    this.socket.on("close", () => this.fail(Error("ConnectionClosed")));
  }
  private fail(error: Error) {
    this.closed = error;
    for (const p of this.pending.splice(0)) p.reject(error);
  }
  request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    // Replies are raw operation-specific JSON. Consumers normalize their model;
    // unsolicited events and deliberately malformed requests stay unknown.
    return this.rawRequest(protocol.envelope(op, args[0])) as Promise<protocol.Response<K>>;
  }
  rawRequest(value: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(json.stringify(value) + "\n");
    });
  }
  async call<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Reply<K>> {
    const reply = await this.request(op, ...args);
    if ("err" in reply) throw Error(reply.err);
    return reply;
  }
  close(): void {
    this.socket.destroy();
  }
}
export async function request<K extends protocol.Op>(
  path: string,
  op: K,
  ...args: protocol.Arguments<K>
): Promise<protocol.Reply<K>> {
  const conn = new Connection(path);
  try {
    return await conn.call(op, ...args);
  } finally {
    conn.close();
  }
}
