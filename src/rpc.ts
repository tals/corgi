import { createConnection as createSocket, type Socket } from "node:net";
import * as errors from "./errors";
import * as json from "./json";
import * as telemetry from "./telemetry";
import * as protocol from "./protocol";
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
export interface ConnectionInit {
  /** Off: untagged requests, one at a time, as before runtime protocol 4. */
  requestIds?: boolean;
}
export class Connection {
  readonly socket: Socket;
  private readonly requestIds: boolean;
  private pending = new Map<number, Pending>();
  private next = 1;
  private buffer = "";
  private closed: Error | null = null;
  constructor(path: string, init?: ConnectionInit);
  constructor(socket: Socket, init?: ConnectionInit);
  constructor(target: string | Socket, init: ConnectionInit = {}) {
    this.requestIds = init.requestIds ?? true;
    this.socket = typeof target === "string" ? createSocket(target) : target;
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
          const decode_started = telemetry.begin();
          const message = json.parse(line);
          telemetry.end("wire.decode", decode_started, telemetry.enabled ? Buffer.byteLength(line) : 0);
          this.receive(message);
        } catch (error) {
          this.fail(error as Error);
          return;
        }
      }
    });
    this.socket.on("error", error => this.fail(error));
    this.socket.on("close", () => this.fail(Error("ConnectionClosed")));
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.socket.destroy();
  }
  private receive(value: unknown): void {
    const message = json.object(value);
    const id = this.requestIds ? protocol.requestId(message) : 0;
    if (id === null) {
      switch (message.type) {
        case "viewer.wake":
        case "agent.history":
        case "session":
        case "agent.preview":
          return;
      }
      // An incompatible daemon can reject the version before understanding ids.
      switch (message.err) {
        case "UnsupportedProtocol":
        case "UnsupportedViewerProtocol":
        case "ProtocolRequired":
          throw Error(message.err);
      }
      throw Error("UnexpectedReply");
    }
    const pending = this.pending.get(id);
    if (!pending) throw Error("UnexpectedReply");
    this.pending.delete(id);
    if (!this.requestIds) {
      pending.resolve(message);
      return;
    }
    const { request_id: _, ...reply } = message;
    pending.resolve(reply);
  }
  request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    // Replies are raw operation-specific JSON. Consumers normalize their model.
    return this.rawRequest(protocol.envelope(op, args[0])) as Promise<protocol.Response<K>>;
  }
  async rawRequest(value: unknown): Promise<unknown> {
    if (this.closed) throw this.closed;
    const message = json.object(value);
    if (!this.requestIds && this.pending.size) throw Error("RequestInFlight");
    if (!Number.isSafeInteger(this.next)) throw Error("RequestIdOverflow");
    const id = this.requestIds ? this.next++ : 0;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.write(json.stringify(this.requestIds ? { ...message, request_id: id } : message) + "\n");
      } catch (error) {
        this.fail(error as Error);
      }
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
  // Management and unversioned requests also reach daemons without correlation.
  const check = protocol.check(op);
  const conn = new Connection(path, { requestIds: check === "runtime" || check === "viewer" });
  try {
    return await conn.call(op, ...args);
  } finally {
    conn.close();
  }
}
/** Hands the daemon to `executable`, waiting out a worktree addition it
 * won't move mid-way; Git gives one up after two minutes. */
export async function reload(path: string, executable: string, wait_ms = 150_000) {
  const until = Date.now() + wait_ms;
  for (;;)
    try {
      return await request(path, "server.reload", { executable });
    } catch (error) {
      if (!errors.is(error, "ReloadBusy") || Date.now() >= until) throw error;
      await Bun.sleep(250);
    }
}
