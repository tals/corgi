//! A lightweight local callback: loading the CLI reporter must not load the
//! provider adapters or native viewer. stdout remains the model's result.
import { createConnection, type Socket } from "node:net";
import type { State } from "./prompt_search";
import type { Request } from "./protocol";

export class Reporter {
  private connection: Socket | null = null;
  private disabled = false;
  private buffer = "";
  private revision = 0;
  private pending: (() => void) | null = null;
  constructor(
    private socket: string,
    private headless: number,
  ) {}
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
        if (reply.ok !== true || reply.request_id !== this.revision) return this.close();
        this.pending?.();
      } catch {
        this.close();
      }
    });
    return connection;
  }
  /** Calls are ordered: the search awaits each bounded update. */
  async send(search: State): Promise<void> {
    if (this.disabled) return;
    const connection = (this.connection ??= this.connect());
    const payload: Request<"headless.search"> = { id: this.headless, search };
    this.revision = search.revision;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.close(), 500);
      this.pending = () => {
        clearTimeout(timer);
        this.pending = null;
        resolve();
      };
      connection.write(JSON.stringify({ op: "headless.search", ...payload, request_id: search.revision }) + "\n");
    });
  }
  close(): void {
    this.disabled = true;
    this.pending?.();
    this.connection?.destroy();
  }
}
