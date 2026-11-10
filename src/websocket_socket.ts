import * as stream from "node:stream";
import * as fs from "node:fs";
import * as start_lock from "./start_lock";
import * as wire_websocket from "./wire_websocket";

// lib.dom supplies the browser overload; the runtime also has Bun's Unix-socket options.
type NativeSocket = Omit<Bun.WebSocket, "onmessage"> & {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};
const NativeWebSocket = globalThis.WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): NativeSocket;
};

/** Bun's native WebSocket as a bounded byte transport, without a relay socket. */
export class Socket extends stream.Duplex {
  private ws: NativeSocket | null = null;
  private opening: ((error?: Error | null) => void) | null = null;
  private writing: ((error?: Error | null) => void) | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private alias: string | null = null;
  /** How the daemon closed it, when it didn't say why in a way a client acts on. */
  closeCode: number | null = null;
  constructor(private readonly path: string) {
    super({ highWaterMark: 65536 });
  }
  override _construct(done: (error?: Error | null) => void): void {
    if (this.destroyed) return done(Error("ConnectionClosed"));
    this.open(done, Date.now() + start_lock.wait_ms);
  }
  /** Opens the WebSocket. One a daemon refuses while it's starting or
   * reloading opens again once it can. */
  private open(done: (error?: Error | null) => void, until: number): void {
    let ws: NativeSocket;
    this.opening = error => {
      // Closed on purpose before it opened: nothing went wrong.
      if (this.destroyed) return done();
      if (!error || Date.now() >= until || !start_lock.held(this.path)) return done(error);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.terminate();
      this.ws = null;
      setTimeout(() => (this.destroyed ? done() : this.open(done, until)), 50);
    };
    try {
      ws = this.ws = new NativeWebSocket(this.address(), {
        protocols: [wire_websocket.protocol],
        perMessageDeflate: false,
      });
    } catch (error) {
      this.opening = null;
      this.releaseAlias();
      done(error as Error);
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.releaseAlias();
      const ready = this.opening;
      this.opening = null;
      ready?.(ws.protocol !== wire_websocket.protocol || ws.extensions ? Error("InvalidWebSocketProtocol") : null);
    };
    ws.onmessage = event => {
      if (this.destroyed) return;
      if (!(event.data instanceof ArrayBuffer)) return this.destroy(Error("InvalidWebSocketMessage"));
      const bytes = Buffer.from(event.data);
      if (this.readableLength + bytes.length > wire_websocket.capacity) return this.destroy(Error("MessageTooLarge"));
      if (!this.push(bytes)) ws.pause();
    };
    ws.onerror = event => {
      const error = "error" in event && event.error instanceof Error ? event.error : Error("WebSocketFailed");
      const ready = this.opening;
      this.opening = null;
      this.releaseAlias();
      if (ready) ready(error);
      else this.destroy(error);
    };
    ws.onclose = event => {
      // XXX: Remove for next protocol bump.
      if (event.code === wire_websocket.rolled_back) return this.destroy(Error("ServerRolledBack"));
      if (event.code === wire_websocket.reloading) return this.destroy(Error("ServerReloading"));
      if (event.code === wire_websocket.going_away) return this.destroy(Error("ServerShutdown"));
      const ready = this.opening;
      this.opening = null;
      this.releaseAlias();
      if (ready) ready(Error("WebSocketConnectFailed"));
      else if (this.writing) this.destroy(Error("ConnectionClosed", { cause: `close code ${event.code}` }));
      else {
        this.closeCode = event.code;
        // Buffered input must be delivered before RPC observes EOF.
        this.push(null);
        this.end();
      }
    };
  }
  private address(): string {
    const address = `ws+unix://${this.path}:/rpc`;
    try {
      const url = new URL(address);
      if (
        this.path.startsWith("/") &&
        !this.path.includes(":") &&
        !url.hash &&
        !url.search &&
        url.pathname === `${this.path}:/rpc`
      )
        return address;
    } catch {}
    // Bun treats the socket name as URL text and splits at the first colon.
    // A private symlink keeps arbitrary filesystem names on the same direct socket.
    this.alias = fs.mkdtempSync("/tmp/corgi-ws-");
    const target = this.path.startsWith("/") ? this.path : `${process.cwd()}/${this.path}`;
    fs.symlinkSync(target, this.alias + "/s");
    return `ws+unix://${this.alias}/s:/rpc`;
  }
  private releaseAlias(): void {
    if (this.alias === null) return;
    try {
      fs.rmSync(this.alias, { recursive: true, force: true });
    } catch {}
    this.alias = null;
  }
  override _read(): void {
    this.ws?.resume();
  }
  override destroy(error?: Error): this {
    // Duplex waits for _construct before _destroy; cancellation must also stop a hung upgrade.
    super.destroy(error);
    this.ws?.terminate();
    return this;
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    const ws = this.ws;
    if (!ws) return done(Error("ConnectionClosed"));
    if (bytes.length > wire_websocket.capacity) return done(Error("RequestBackpressure"));
    this.writing = done;
    // Bun reports closing before `onclose`; the close code, such as a reload's, says why.
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(bytes);
      this.drain();
    } catch (error) {
      this.writing = null;
      done(error as Error);
    }
  }
  /** Finishes a write once Bun has sent it; a slow reader is checked less
   * and less often, up to every 50 ms. */
  private drain(delay = 1): void {
    this.poll = null;
    if (this.destroyed) return;
    if (this.ws?.bufferedAmount) {
      this.poll = setTimeout(() => this.drain(Math.min(delay * 2, 50)), delay);
      return;
    }
    const done = this.writing;
    this.writing = null;
    done?.();
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    if (this.poll !== null) clearTimeout(this.poll);
    const writing = this.writing;
    this.writing = null;
    writing?.(error ?? Error("ConnectionClosed"));
    this.ws?.terminate();
    this.releaseAlias();
    done(error);
  }
}
