import { n, ptr, ReadyLoop, READ, WRITE } from "./native_bridge";
import * as json from "./json";
import type { Control } from "./protocol";
import type { Interest } from "./viewer_protocol";
import type { Subscription } from "./launch_service";
export class Client {
  viewer_id = 0;
  active_seq = 0;
  next_control = 1n;
  last_control = 0n;
  view_workspace = 0;
  controls: Control[] = [];
  viewer = false;
  view_focus: number | null = null;
  interests: Interest[] = [];
  protocol_version: number | null = null;
  subscribed = false;
  watching = false;
  watch_viewer = 0;
  woken = 0n;
  launch_preview: Subscription | null = null;
  snapshot_revision: bigint | null = null;
  last_snapshot = 0;
  watched = true;
  session_hash = 0n;
  session_shown = 0n;
  session_bucket = 0;
  resource_detail: number | null = null;
  worktree_detail: number | null = null;
  resources = true;
  dead = false;
  touched = Date.now();
  input: Buffer = Buffer.alloc(0);
  output: Buffer = Buffer.alloc(0);
  sent = 0;
  /** One HTTP POST instead of JSON lines: `corgi-hook` sends hooks this way.
   * Its body is a request envelope; the reply is the HTTP response, and the
   * connection closes after it. */
  http: "no" | "request" | "replied" = "no";
  private lines = 0;
  pending: any[] = [];
  private busy = false;
  private paused = false;
  private registration: ReturnType<ReadyLoop["watch"]> | null = null;
  private scratch = Buffer.alloc(65536);
  constructor(
    readonly fd: number,
    private loop: ReadyLoop,
    readonly receive: (client: Client, value: any) => void,
    readonly disconnected: () => void,
    start = true,
  ) {
    this.paused = !start;
    if (start) this.resume();
  }
  queue(value: unknown): void {
    if (this.dead) return;
    if (this.http === "replied") return;
    if (this.http === "request") {
      const body = json.stringify(value) + "\n";
      const status = value && typeof value === "object" && "err" in value ? "400 Bad Request" : "200 OK";
      this.output = Buffer.from(
        `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      this.sent = 0;
      this.http = "replied";
      this.flush();
      this.arm();
      return;
    }
    const bytes = Buffer.from(json.stringify(value) + "\n");
    if (this.output.length - this.sent + bytes.length > 4 * 1024 * 1024) {
      this.close();
      return;
    }
    this.output = Buffer.concat([this.output.subarray(this.sent), bytes]);
    this.sent = 0;
    this.flush();
    this.arm();
  }
  reply(_op: string, value: object): void {
    this.queue({ ok: true, ...value });
  }
  flush(): void {
    if (this.paused) return;
    while (this.sent < this.output.length && !this.dead) {
      const b = this.output.subarray(this.sent),
        count = n.probe_write(this.fd, ptr(b), b.length);
      if (count > 0) this.sent += count;
      else if (count === -4) continue;
      else if (count === -11 || count === -35) break;
      else {
        this.close();
        return;
      }
    }
    if (this.sent === this.output.length) {
      this.output = Buffer.alloc(0);
      this.sent = 0;
      if (this.http === "replied") this.close();
    }
  }
  private read(): void {
    for (let i = 0; i < 8 && !this.dead; i++) {
      const count = n.probe_read(this.fd, ptr(this.scratch), this.scratch.length);
      if (count > 0) {
        this.input = Buffer.concat([this.input, this.scratch.subarray(0, count)]);
        if (this.input.length > 4 * 1024 * 1024) {
          this.close();
          return;
        }
        if (
          this.http === "no" &&
          this.lines === 0 &&
          this.input.length >= 5 &&
          this.input.subarray(0, 5).toString() === "POST "
        )
          this.http = "request";
        if (this.http !== "no") {
          this.readHttp();
          continue;
        }
        for (;;) {
          const end = this.input.indexOf(10);
          if (end < 0) break;
          const line = this.input.subarray(0, end).toString();
          this.input = Buffer.from(this.input.subarray(end + 1));
          this.lines++;
          try {
            this.touched = Date.now();
            this.pending.push(json.parse(line));
            this.dispatch();
          } catch {
            this.queue({ err: "InvalidJson" });
          }
        }
      } else if (count === -4) continue;
      else if (count === -11 || count === -35) break;
      else {
        this.close();
        return;
      }
    }
  }
  /** Takes the request once its head and Content-Length body have arrived. */
  private readHttp(): void {
    if (this.http !== "request" || this.pending.length || this.busy) return;
    const head = this.input.indexOf("\r\n\r\n");
    if (head < 0) return;
    const length = /\r\ncontent-length:\s*(\d+)\r\n/i.exec(this.input.subarray(0, head + 2).toString("latin1"));
    if (!length) {
      this.queue({ err: "LengthRequired" });
      return;
    }
    const end = head + 4 + Number(length[1]);
    if (this.input.length < end) return;
    const body = this.input.subarray(head + 4, end).toString();
    this.input = Buffer.alloc(0);
    try {
      this.touched = Date.now();
      this.pending.push(json.parse(body));
      this.dispatch();
    } catch {
      this.queue({ err: "InvalidJson" });
    }
  }
  private arm(): void {
    if (!this.dead) this.registration?.arm(READ | (this.output.length > this.sent ? WRITE : 0));
  }
  private dispatch(): void {
    if (this.paused || this.dead || this.busy || !this.pending.length) return;
    this.busy = true;
    this.receive(this, this.pending[0]);
  }
  take(): any {
    return this.pending.shift();
  }
  done(): void {
    this.busy = false;
    this.dispatch();
  }
  resume(): void {
    this.paused = false;
    if (this.registration || this.dead) return;
    this.registration = this.loop.watch(this.fd, () => {
      this.read();
      this.flush();
      this.arm();
    });
    this.flush();
    this.arm();
    this.dispatch();
  }
  pause(): void {
    this.paused = true;
    this.registration?.close();
    this.registration = null;
  }
  savedInput(): Buffer {
    return Buffer.concat([...this.pending.map(value => Buffer.from(json.stringify(value) + "\n")), this.input]);
  }
  restoreInput(data: Buffer): void {
    this.input = data;
    for (;;) {
      const end = this.input.indexOf(10);
      if (end < 0) break;
      this.pending.push(json.parse(this.input.subarray(0, end).toString()));
      this.input = Buffer.from(this.input.subarray(end + 1));
    }
  }
  clearControls(): void {
    this.controls = [];
  }
  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.pause();
    n.probe_close(this.fd);
    this.disconnected();
  }
}
