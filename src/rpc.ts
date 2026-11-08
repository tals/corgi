import { createConnection as createSocket } from "node:net";
import type { Duplex } from "node:stream";
import * as errors from "./errors";
import * as json from "./json";
import * as telemetry from "./telemetry";
import * as protocol from "./protocol";
import * as wire_compression from "./wire_compression";
import * as websocket_socket from "./websocket_socket";
import type { Stats } from "./connection_stats";
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  encoding?: string[];
}
export interface ConnectionInit {
  /** Management probes can still reach installations predating WebSocket support. */
  transport?: "websocket" | "stream";
  /** Off: untagged requests, one at a time, as before runtime protocol 4. */
  requestIds?: boolean;
  compression?: boolean;
  stats?: Stats;
  trace?: telemetry.Details;
  timeout_ms?: number | (() => number);
}
export class Connection {
  readonly socket: Duplex;
  private readonly requestIds: boolean;
  private pending = new Map<number, Pending>();
  private next = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private codec: wire_compression.Channel | null = null;
  private readonly compression: boolean;
  private negotiating = false;
  private started = false;
  private closed: Error | null = null;
  private ending: Error | null = null;
  private listeners = new Set<(event: protocol.Event) => void>();
  private closedListeners = new Set<() => void>();
  private readonly timeout: number | (() => number);
  get timeout_ms(): number {
    return typeof this.timeout === "function" ? this.timeout() : this.timeout;
  }
  get draining(): boolean {
    return this.ending !== null && this.closed === null;
  }
  get disconnected(): boolean {
    return this.closed !== null;
  }
  get failure(): Error | null {
    return this.closed;
  }
  private readonly stats?: Stats;
  private readonly trace?: telemetry.Details;
  constructor(target: string | Duplex, options: ConnectionInit | number = {}) {
    const init = typeof options === "number" ? { timeout_ms: options } : options;
    this.stats = init.stats;
    this.compression = init.compression ?? false;
    this.trace = init.trace;
    if (this.stats) this.stats.connections++;
    this.timeout = init.timeout_ms ?? 0;
    this.requestIds = init.requestIds ?? true;
    this.socket =
      typeof target !== "string"
        ? target
        : init.transport === "stream"
          ? createSocket(target)
          : new websocket_socket.Socket(target);
    this.socket.on("data", (chunk: Buffer) => {
      this.stats?.traffic("received", chunk.length);
      this.read(chunk);
    });
    this.socket.on("error", error => this.finish(error));
    this.socket.on("close", () => this.finish(Error("ConnectionClosed")));
  }
  private finish(error: Error): void {
    if (this.closed || this.ending) return;
    this.ending = error;
    // EOF and resets can follow bytes before the asynchronous decoder emits their last message.
    if (this.codec) void this.codec.drainInput().then(() => this.fail(error));
    else this.fail(error);
  }
  private read(chunk: Buffer, decoded = false): void {
    if (this.closed) return;
    if (this.codec && !decoded) {
      this.codec.decode(chunk);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 64 * 1024 * 1024) {
      this.fail(Error("MessageTooLarge"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = Buffer.from(this.buffer.subarray(newline + 1));
      if (!line.length) continue;
      try {
        const started = telemetry.begin();
        const message = json.parse(line.toString());
        telemetry.end("wire.decode", started, line.length);
        this.receive(message);
      } catch (error) {
        this.fail(error as Error);
        return;
      }
      if (!decoded && this.codec) {
        const rest = this.buffer;
        this.buffer = Buffer.alloc(0);
        if (rest.length) this.codec.decode(rest);
        return;
      }
    }
  }
  private write(bytes: Buffer): void {
    if (this.closed || this.ending) return;
    if (this.socket.writableLength + bytes.length > 4 * 1024 * 1024) {
      this.fail(Error("RequestBackpressure"));
      return;
    }
    this.stats?.traffic("sent", bytes.length);
    this.socket.write(bytes);
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = error;
    this.codec?.close();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.socket.destroy();
    for (const listener of this.closedListeners) listener();
    this.closedListeners.clear();
  }
  private receive(value: unknown): void {
    const message = json.object(value);
    const id = this.requestIds ? protocol.requestId(message) : 0;
    if (id === null) {
      const event = protocol.event(message);
      if (event) {
        for (const listener of this.listeners) listener(event);
        return;
      }
      // An untagged error (a rejected version, a line the daemon could not
      // parse) answers no one request; it fails the connection under its name.
      throw Error(typeof message.err === "string" ? message.err : "UnexpectedReply");
    }
    if (message.type === "viewer.stream") {
      const event = protocol.event(message);
      if (event) for (const listener of this.listeners) listener(event);
    }
    const pending = this.pending.get(id);
    if (!pending) throw Error("UnexpectedReply");
    const selected = protocol.encoding(message.content_encoding);
    if (
      message.content_encoding !== undefined &&
      (message.type !== "hello" || !selected || !pending.encoding?.includes(selected) || this.codec)
    )
      throw Error("InvalidEncodingNegotiation");
    this.pending.delete(id);
    if (pending.encoding) {
      this.negotiating = false;
      if (selected === "zstd")
        this.codec = new wire_compression.Channel(
          bytes => this.write(bytes),
          bytes => this.read(bytes, true),
          error => this.fail(error),
        );
    }
    if (!this.requestIds) {
      pending.resolve(message);
      return;
    }
    const { request_id: _, ...reply } = message;
    pending.resolve(reply);
  }
  onEvent(listener: (event: protocol.Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Socket EOF and errors notify after decoding all received bytes; close() aborts immediately. */
  onClose(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }
  request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    // Replies are raw operation-specific JSON. Consumers normalize their model.
    return this.rawRequest(protocol.envelope(op, args[0])) as Promise<protocol.Response<K>>;
  }
  async rawRequest(value: unknown): Promise<unknown> {
    const closed = this.closed ?? this.ending;
    if (closed) throw closed;
    const message = json.object(value);
    if (this.negotiating) throw Error("CompressionNegotiating");
    let encoding: string[] | undefined;
    if (message.op === "hello") {
      if (this.compression && !this.started && message.accept_encoding === undefined)
        message.accept_encoding = [...protocol.encodings];
      encoding = protocol.decode("hello", message).accept_encoding;
      if (encoding.length && this.started) throw Error("InvalidEncodingNegotiation");
      this.negotiating = encoding.length > 0;
    }
    if (!this.requestIds && this.pending.size) throw Error("RequestInFlight");
    if (this.pending.size >= 128) throw Error("RequestBackpressure");
    this.started = true;
    const id = this.requestIds ? this.next++ : 0;
    return new Promise((resolve, reject) => {
      const timeout = this.timeout_ms;
      const timer = timeout > 0 ? setTimeout(() => this.fail(Error("RequestTimedOut")), timeout) : null;
      const started = performance.now();
      if (this.stats) this.stats.pending++;
      const done = (failed: boolean) => {
        if (this.stats) {
          this.stats.pending--;
          const now = performance.now();
          // Hello may include SSH authentication; it is not an established-path round trip.
          this.stats.answer(now - started, failed, now, message.op !== "hello");
        }
        if (telemetry.enabled && this.trace)
          telemetry.end("remote.rpc", started, 0, {
            ...this.trace,
            op: typeof message.op === "string" ? message.op : "unknown",
            request: id,
            failed: Number(failed),
            timeout_ms: timeout,
          });
        if (timer) clearTimeout(timer);
      };
      this.pending.set(id, {
        encoding,
        resolve: value => {
          done(false);
          resolve(value);
        },
        reject: error => {
          done(true);
          reject(error);
        },
      });
      try {
        const bytes = Buffer.from(json.stringify(this.requestIds ? { ...message, request_id: id } : message) + "\n");
        if (this.codec) this.codec.encode(bytes);
        else this.write(bytes);
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }
  async call<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Reply<K>> {
    const reply = await this.request(op, ...args);
    if ("err" in reply) throw errors.fromReply(reply);
    return reply;
  }
  close(): void {
    this.fail(Error("ConnectionClosed"));
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
  const runtime = check === "runtime" || check === "viewer";
  const conn = new Connection(path, { requestIds: runtime, transport: runtime ? "websocket" : "stream" });
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
