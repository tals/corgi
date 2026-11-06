import * as rpc from "./rpc";
import * as startup from "./startup";
import { Quit } from "./subprocess";
import type { Provider } from "./providers";

/** A launch owns its report connection until exec. Losing it removes the wait. */
export class Reporter implements startup.Progress {
  readonly quit = new Quit();
  private readonly id = crypto.randomUUID();
  private readonly started_at = Date.now();
  private phase: startup.Phase = "discovering";
  private detail = "";
  private lines = { stdout: "", stderr: "" };
  private conn: rpc.Connection | null = null;
  private timer: ReturnType<typeof setInterval>;
  private pending: Promise<void> | null = null;
  private closed = false;
  private interrupt = () => this.quit.signal();
  constructor(
    private provider: Provider,
    private pane: number,
    private socket: string,
  ) {
    process.on("SIGINT", this.interrupt);
    process.on("SIGTERM", this.interrupt);
    process.on("SIGHUP", this.interrupt);
    this.timer = setInterval(() => void this.send(), 500);
    void this.send();
  }
  update(phase: startup.Phase, detail = "") {
    this.phase = phase;
    this.detail = startup.clean(detail);
    void this.send();
  }
  output(bytes: Buffer, stream: "stdout" | "stderr") {
    process[stream].write(bytes);
    const parts = (this.lines[stream] + bytes.toString()).split(/[\r\n]/);
    this.lines[stream] = parts.pop()!.slice(-1024);
    for (const line of [...parts, this.lines[stream]]) {
      const detail = startup.clean(line);
      if (!detail) continue;
      this.detail = detail;
      if (startup.installing(line)) this.phase = "installing";
    }
  }
  private send(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        this.conn ??= new rpc.Connection(this.socket, { requestIds: false });
        const reply = await this.conn.call("startup", {
          id: this.id,
          pane: this.pane,
          provider: this.provider,
          phase: this.phase,
          detail: this.detail,
          started_at: this.started_at,
        });
        if (reply.cancelled) this.quit.signal();
      } catch {
        this.conn?.close();
        this.conn = null;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
  check() {
    if (this.quit.aborted) throw Error("Cancelled");
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.conn?.close();
    process.off("SIGINT", this.interrupt);
    process.off("SIGTERM", this.interrupt);
    process.off("SIGHUP", this.interrupt);
  }
}
