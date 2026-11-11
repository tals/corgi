//! The viewer's sign-in screen. The daemon owns the process and account;
//! this mirror owns only rendering, selection and delivery of input.
import { call, type Transport } from "./mirror";
import { Terminal } from "./pane/terminal";
import * as viewerNative from "./viewer_native";
import * as surface from "./pane/surface";
import * as errors from "./errors";
import { problem, type Host, type Drawn } from "./signin";
import type { Provider } from "./providers";
import type * as protocol from "./protocol";
import type { Snapshot } from "./signin_service";

type Input = { input_seq: number; input: string; raw: boolean; x: number; y: number };
export class Signin {
  readonly id = crypto.randomUUID();
  provider: Provider;
  account = "";
  name: string | null = null;
  cwd = "";
  cols = 80;
  rows = 24;
  working: string | null = null;
  typing = false;
  child: Terminal | null = null;
  over = false;
  private opened = false;
  private opening: protocol.RequestInput<"account.signin.open"> | null = null;
  private revision = 0;
  private input_seq = 0;
  private failedAt: number | null = null;
  private queue: Input[] = [];
  private pending = false;
  private timer?: ReturnType<typeof setInterval>;
  private drawn: Drawn = { frame: "", cursor: null, mouse: "frame" };
  constructor(
    private transport: () => Transport,
    readonly adding: boolean,
    provider: Provider,
    private target: string,
    private host: Host,
  ) {
    this.provider = provider;
  }
  async open(cols: number, rows: number): Promise<void> {
    this.cols = cols;
    this.rows = rows;
    this.opening = {
      id: this.id,
      provider: this.provider,
      account: this.target,
      add: this.adding,
      cwd: this.cwd,
      cols,
      rows,
    };
    this.timer = setInterval(() => void this.poll(), 100);
    await this.poll();
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    void this.poll();
  }
  body() {
    return { x: 1, y: 1, cols: Math.max(1, this.cols - 2), rows: Math.max(1, this.rows - 5) };
  }
  private enqueue(input = "", raw = false, x = -1, y = -1): void {
    if (this.over) return;
    this.queue.push({ input_seq: ++this.input_seq, input, raw, x, y });
    void this.poll();
  }
  input(bytes: Uint8Array | string): Promise<void> {
    this.enqueue((typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes)).toString("base64"));
    return Promise.resolve();
  }
  send(bytes: Uint8Array | string): void {
    this.enqueue(Buffer.from(bytes).toString("base64"), true);
  }
  click(x: number, y: number): Promise<void> {
    this.enqueue("", false, x, y);
    return Promise.resolve();
  }
  private async poll(): Promise<void> {
    if (this.pending || this.over || !this.opening) return;
    this.pending = true;
    try {
      if (!this.opened) {
        await call(this.transport(), "account.signin.open", this.opening);
        this.opened = true;
      }
      if (this.over) {
        void this.closeRemote();
        return;
      }
      const input = this.queue[0];
      const reply = await call(this.transport(), "account.signin.sync", {
        id: this.id,
        cols: this.cols,
        rows: this.rows,
        revision: this.revision,
        ...(input ?? { input_seq: 0 }),
      });
      if (input) this.queue.shift();
      if (!this.over && reply.state) this.receive(reply.state);
      this.failedAt = null;
    } catch (error) {
      const transient = [
        "StaleConnection",
        "ReplyLost",
        "ConnectionClosed",
        "ServerShutdown",
        "RequestTimedOut",
        "NotConnected",
        "Reloading",
      ].includes(errors.name(error) ?? "");
      this.failedAt ??= Date.now();
      if (!transient || Date.now() - this.failedAt >= 120_000) this.finish(1, false, problem(error));
    } finally {
      this.pending = false;
      // Drain queued typing as replies arrive rather than one key per poll.
      if (!this.over && this.queue.length && this.failedAt === null) queueMicrotask(() => void this.poll());
    }
  }

  private receive(s: protocol.Wire<Snapshot>): void {
    this.revision = s.revision;
    this.provider = s.provider ?? this.provider;
    this.account = s.account;
    this.name = s.name;
    this.working = s.working;
    this.typing = s.typing;
    this.drawn = s.drawn;
    if (s.child) {
      this.child ??= new Terminal(s.child.surface.cols, s.child.surface.rows);
      viewerNative.receiveFrame(this.child.handle, surface.view(s.child));
    } else {
      this.child?.destroy();
      this.child = null;
    }
    this.host.changed();
    if (s.result) this.finish(s.result.status, s.result.start, s.result.message);
  }
  draw(_x: number, _y: number, hovered: bigint | null = null): Drawn {
    let frame = this.drawn.frame;
    if (this.typing && !this.working && this.child && this.cols >= 30 && this.rows >= 10) {
      const b = this.body();
      viewerNative.updateRender(this.child.handle);
      frame += viewerNative.rows(this.child.handle, 0, b.x, b.y, b.cols, b.rows, false, hovered) + "\x1b[0m";
    }
    return { ...this.drawn, frame };
  }
  private async closeRemote(): Promise<void> {
    try {
      await call(this.transport(), "account.signin.close", { id: this.id });
    } catch {
      /* The daemon's lease cleans up. */
    }
  }
  private finish(status: number, start: boolean, message: string): void {
    if (this.over) return;
    this.abandon();
    this.host.done(status, start, message);
  }
  abandon(): void {
    if (this.over) return;
    this.over = true;
    clearInterval(this.timer);
    this.child?.destroy();
    this.child = null;
    void this.closeRemote();
  }
}
