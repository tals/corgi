import * as http from "node:http";
import * as json from "./json";
import * as errors from "./errors";
import * as protocol from "./protocol";
import * as start_lock from "./start_lock";

/** How long the daemon may take to answer `value`: a start waits 60 s for
 * the provider's session, after discovery and setup. */
function limit(value: unknown): number {
  return protocol.parse(value) === "headless.start" ? 120_000 : 45_000;
}
/** One envelope, sent as is in a POST on the daemon's Unix socket; the reply comes back as is too.
 * While a daemon is starting or reloading, it waits for one for up to `wait_ms`. */
async function send(
  socket: string,
  value: unknown,
  limit_ms: number,
  wait_ms: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const until = Date.now() + wait_ms,
    // A daemon that took the request and hung up may have run it: only discovery goes again.
    repeatable = protocol.parse(value) === "hello";
  for (;;)
    try {
      return await once(socket, value, limit_ms, signal);
    } catch (error) {
      if (signal?.aborted || Date.now() >= until || !start_lock.waitable(socket, error)) throw error;
      if (!repeatable && !unread(error)) throw error;
      await Bun.sleep(50);
    }
}
/** Whether the kernel failed the connection before the daemon read the
 * request: no daemon, or one that never took the connection. A daemon that
 * took it and hung up is a hang-up, which names no system call. */
function unread(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException)?.syscall === "string";
}
function once(socket: string, value: unknown, limit_ms: number, signal?: AbortSignal): Promise<unknown> {
  const body = Buffer.from(json.stringify(json.object(value)));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error, reply?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.destroy();
      if (error) reject(error);
      else resolve(reply);
    };
    const request = http.request(
      {
        socketPath: socket,
        method: "POST",
        path: "/rpc",
        agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": body.length, Connection: "close" },
      },
      response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("error", () => finish(Error("IncompleteHttpReply")));
        response.on("data", (chunk: Buffer) => {
          if (done) return;
          size += chunk.length;
          if (size > 64 * 1024 * 1024) finish(Error("MessageTooLarge"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (done) return;
          if (response.statusCode !== 200 && response.statusCode !== 400) return finish(Error("UnexpectedHttpStatus"));
          try {
            finish(undefined, json.parse(Buffer.concat(chunks, size).toString()));
          } catch (error) {
            finish(error as Error);
          }
        });
      },
    );
    const timer = setTimeout(() => finish(Error("RequestTimedOut")), limit_ms);
    request.on("error", error => finish(error));
    // Closing the connection is how the daemon hears a request was given up.
    if (signal?.aborted) return finish(Error("Cancelled"));
    signal?.addEventListener("abort", () => finish(Error("Cancelled")), { once: true });
    request.end(body);
  });
}
/** A daemon to ask: over HTTP, or over a connection a command already has
 * open, as one to another machine. `socket` is where it listens here. */
export interface Daemon {
  readonly socket: string;
  call<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Reply<K>>;
  request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>>;
}
/** The daemon at `socket`, asked over HTTP: each request is its own POST. */
export class Client {
  constructor(readonly socket: string) {}
  /** `op`'s reply; its error throws. */
  async call<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Reply<K>> {
    const reply = await this.request(op, ...args);
    if ("err" in reply) throw errors.fromReply(reply);
    return reply;
  }
  /** `op`'s reply, or its error. */
  async request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    if (op === "hello" && args[0] === undefined) return (await this.discover()) as protocol.Response<K>;
    return json.object(await this.post(protocol.envelope(op, args[0]))) as protocol.Response<K>;
  }
  /** An envelope as written, as an older daemon reads it; its reply as sent.
   * `signal` gives it up, closing its connection. */
  post(value: unknown, limit_ms = limit(value), wait_ms = start_lock.wait_ms, signal?: AbortSignal): Promise<unknown> {
    return send(this.socket, value, limit_ms, wait_ms, signal);
  }
  /** The daemon's `hello`, which any daemon answers whatever its runtime
   * protocol; `wait_ms` is how long to wait for one that's starting, and
   * `finishing_ms` for one finishing an update an older build started. */
  async discover(
    limit_ms = 10_000,
    wait_ms = start_lock.wait_ms,
    finishing_ms = wait_ms,
  ): Promise<protocol.Response<"hello">> {
    const until = Date.now() + finishing_ms;
    for (;;) {
      const hello = json.object(await this.post(protocol.envelope("hello"), limit_ms, wait_ms));
      if (typeof hello.err !== "string" && !(hello.type === "hello" && Number.isSafeInteger(hello.protocol)))
        throw Error("UnexpectedReply");
      // XXX: Remove for next protocol bump.
      if (hello.err !== "UpdateIncomplete" || Date.now() >= until) return hello as protocol.Response<"hello">;
      await Bun.sleep(50);
    }
  }
  /** Hands the daemon to `executable`, waiting out work it won't move
   * mid-way: Git gives up a worktree addition after two minutes. */
  async reload(executable: string, wait_ms = 150_000): Promise<protocol.Reply<"server.reload">> {
    const until = Date.now() + wait_ms;
    for (;;)
      try {
        return await this.call("server.reload", { executable });
      } catch (error) {
        if (!errors.is(error, "ReloadBusy") || Date.now() >= until) throw error;
        await Bun.sleep(250);
      }
  }
}
