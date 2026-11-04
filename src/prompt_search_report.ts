//! What a command the prompt's model runs tells its session: a search's
//! progress, and a memory line it wrote. A lightweight local callback:
//! loading the CLI reporter must not load the provider adapters or native
//! viewer. stdout remains the model's result.
import { createConnection, type Socket } from "node:net";
import type { Change } from "./prompt_memory";
import type { State } from "./prompt_search";
import type { Request } from "./protocol";

export class Reporter {
  private connection: Socket | null = null;
  private disabled = false;
  private buffer = "";
  /** The request whose reply is awaited. */
  private awaited = 0;
  private sent = 0;
  private pending: (() => void) | null = null;
  constructor(
    private socket: string,
    private headless: number,
  ) {}
  /** The reporter for the prompt session this command runs in, as its
   * environment names it; null outside one, as in the user's own shell. */
  static here(env: Record<string, string | undefined> = process.env): Reporter | null {
    const headless = Number(env.CORGI_HEADLESS_ID);
    return env.CORGI_SOCKET && Number.isSafeInteger(headless) && headless > 0
      ? new Reporter(env.CORGI_SOCKET, headless)
      : null;
  }
  private connect(): Socket {
    const connection = createConnection(this.socket);
    connection.setEncoding("utf8");
    connection.on("error", () => this.close());
    connection.on("close", () => this.close());
    connection.on("data", chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 65536) return this.close();
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const reply = JSON.parse(line);
        if (reply.ok !== true || reply.request_id !== this.awaited) return this.close();
        this.pending?.();
      } catch {
        this.close();
      }
    });
    return connection;
  }
  /** Calls are ordered: the search awaits each bounded update. */
  send(search: State): Promise<void> {
    return this.call("headless.search", { id: this.headless, search }, search.revision);
  }
  /** Tells the session a line `corgi memory` wrote, so its thread shows it
   * and /erase can strike it. */
  memory(change: Change): Promise<void> {
    return this.call("headless.memory", { id: this.headless, ...change }, ++this.sent);
  }
  private async call<Op extends "headless.search" | "headless.memory">(
    op: Op,
    payload: Request<Op>,
    request_id: number,
  ): Promise<void> {
    if (this.disabled) return;
    const connection = (this.connection ??= this.connect());
    this.awaited = request_id;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.close(), 500);
      this.pending = () => {
        clearTimeout(timer);
        this.pending = null;
        resolve();
      };
      connection.write(JSON.stringify({ op, ...payload, request_id }) + "\n");
    });
  }
  close(): void {
    this.disabled = true;
    this.pending?.();
    this.connection?.destroy();
  }
}
