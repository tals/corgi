import type { Wait as StartupWait } from "./startup";
import * as telemetry from "./telemetry";
import { n, ptr, ReadyLoop, READ, WRITE } from "./native_bridge";
import * as json from "./json";
import * as flow from "./flow";
import * as text from "./text";
import type { Control } from "./protocol";
import type { Interest } from "./viewer_protocol";
import type { Subscription } from "./launch_service";
/** A request owns its response even when it completes after another request. */
export class Reply {
  constructor(
    private client: Client,
    readonly id: number | null = null,
  ) {}
  send(value: object): void {
    this.client.queue(this.id === null ? value : { ...value, request_id: this.id });
  }
  ok(value: object = {}): void {
    this.send({ ok: true, ...value });
  }
}
export class Client {
  viewer_id = 0;
  viewer_pid = 0;
  active_seq = 0;
  /** When the viewer last had input from its user, in ms. */
  input_at = 0;
  next_control = 1n;
  last_control = 0n;
  view_workspace = 0;
  controls: Control[] = [];
  viewer = false;
  /** What the viewer found out about its terminal, for bug reports. */
  terminal: unknown = null;
  view_focus: number | null = null;
  interests: Interest[] = [];
  protocol_version: number | null = null;
  startup_wait: StartupWait | null = null;
  subscribed = false;
  /** Whether terminal output alone pushes this subscriber a snapshot. */
  subscribed_output = true;
  watching = false;
  watch_viewer = 0;
  woken = 0n;
  launch_preview: Subscription | null = null;
  headless_start: { id: number; deadline: number; request_id?: number | null } | null = null;
  /** An untagged deferred request is running; later requests wait for its reply. */
  held = false;
  snapshot_revision: bigint | null = null;
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
  private sizes: number[] = [];
  private queued_bytes = 0;
  private active_bytes = 0;
  private deferred_bytes = 0;
  private deferred = 0;
  private parsing = false;
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
    readonly drained: (client: Client) => void = () => {},
  ) {
    this.paused = !start;
    if (start) this.resume();
  }
  queue(value: unknown): void {
    if (this.dead) return;
    if (this.http === "replied") return;
    if (this.http === "request") {
      let body = json.stringify(value) + "\n";
      if (text.byteLength(body) > flow.output_bytes - 256) {
        value = { err: "MessageTooLarge" };
        body = json.stringify(value) + "\n";
      }
      const status = value && typeof value === "object" && "err" in value ? "400 Bad Request" : "200 OK";
      this.output = Buffer.from(
        `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${text.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      this.sent = 0;
      this.http = "replied";
      this.flush();
      this.arm();
      return;
    }
    const encode_started = telemetry.begin();
    const bytes = Buffer.from(json.stringify(value) + "\n");
    telemetry.end("wire.encode", encode_started, bytes.length);
    if (bytes.length > flow.output_bytes) {
      const id = value && typeof value === "object" && "request_id" in value ? { request_id: value.request_id } : {};
      this.queue({ err: "MessageTooLarge", ...id });
      return;
    }
    if (this.output.length - this.sent + bytes.length > flow.output_bytes) {
      this.close();
      return;
    }
    this.output = Buffer.concat([this.output.subarray(this.sent), bytes]);
    this.sent = 0;
    this.flush();
    this.arm();
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
    if (this.output.length > 0 && this.sent === this.output.length) {
      this.output = Buffer.alloc(0);
      this.sent = 0;
      if (this.http === "replied") this.close();
      else this.drained(this);
    }
  }
  /** Raw input and decoded requests share a byte budget. */
  get retainedBytes(): number {
    return this.input.length + this.queued_bytes + this.active_bytes + this.deferred_bytes;
  }
  private accepting(): boolean {
    return (
      !this.paused &&
      !this.dead &&
      this.http !== "replied" &&
      this.pending.length + this.deferred + Number(this.busy) < flow.requests &&
      this.output.length - this.sent < flow.output_high
    );
  }
  private readable(): boolean {
    return this.accepting() && this.retainedBytes < flow.request_bytes;
  }
  private read(): void {
    for (let i = 0; i < 8 && this.readable(); i++) {
      const count = n.probe_read(
        this.fd,
        ptr(this.scratch),
        Math.min(this.scratch.length, flow.request_bytes - this.retainedBytes),
      );
      if (count > 0) {
        this.input = Buffer.concat([this.input, this.scratch.subarray(0, count)]);
        this.parse();
      } else if (count === -4) continue;
      else if (count === -11 || count === -35) break;
      else {
        this.close();
        return;
      }
    }
  }
  private parse(): void {
    if (this.parsing || this.paused || this.dead) return;
    this.parsing = true;
    try {
      if (
        this.http === "no" &&
        this.lines === 0 &&
        this.input.length >= 5 &&
        this.input.subarray(0, 5).toString() === "POST "
      )
        this.http = "request";
      if (this.http !== "no") {
        this.readHttp();
        return;
      }
      let offset = 0;
      while (this.accepting()) {
        const end = this.input.indexOf(10, offset);
        if (end < 0) break;
        const line = this.input.subarray(offset, end).toString(),
          size = end + 1 - offset;
        offset = end + 1;
        this.lines++;
        try {
          this.pending.push(json.parse(line));
          this.sizes.push(size);
          this.queued_bytes += size;
          this.touched = Date.now();
        } catch {
          this.queue({ err: "InvalidJson" });
        }
      }
      if (offset) this.input = Buffer.from(this.input.subarray(offset));
      if (this.input.length >= flow.request_bytes && this.input.indexOf(10) < 0) this.close();
    } finally {
      this.parsing = false;
    }
    this.dispatch();
  }
  /** Takes the request once its head and Content-Length body have arrived. */
  private readHttp(): void {
    if (this.http !== "request" || this.pending.length || this.busy) return;
    const head = this.input.indexOf("\r\n\r\n");
    if (head < 0) {
      if (this.input.length >= flow.request_bytes) this.queue({ err: "MessageTooLarge" });
      return;
    }
    const length = /\r\ncontent-length:\s*(\d+)\r\n/i.exec(this.input.subarray(0, head + 2).toString("latin1"));
    if (!length) {
      this.queue({ err: "LengthRequired" });
      return;
    }
    const end = head + 4 + Number(length[1]);
    if (!Number.isSafeInteger(end) || end > flow.request_bytes) {
      this.queue({ err: "MessageTooLarge" });
      return;
    }
    if (this.input.length < end) return;
    const body = this.input.subarray(head + 4, end).toString();
    this.input = Buffer.alloc(0);
    try {
      this.touched = Date.now();
      this.pending.push(json.parse(body));
      this.sizes.push(end);
      this.queued_bytes += end;
      this.dispatch();
    } catch {
      this.queue({ err: "InvalidJson" });
    }
  }
  private arm(): void {
    if (!this.dead) this.registration?.arm((this.readable() ? READ : 0) | (this.output.length > this.sent ? WRITE : 0));
  }
  private dispatch(): void {
    if (
      this.paused ||
      this.dead ||
      this.busy ||
      this.headless_start ||
      !this.pending.length ||
      this.deferred >= flow.requests ||
      this.output.length - this.sent >= flow.output_high
    )
      return;
    this.busy = true;
    this.receive(this, this.pending[0]);
  }
  take(): any {
    this.active_bytes = this.sizes.shift() ?? 0;
    this.queued_bytes -= this.active_bytes;
    return this.pending.shift();
  }
  done(): void {
    this.busy = false;
    this.active_bytes = 0;
    this.parse();
    this.dispatch();
    this.arm();
  }
  /** A tagged operation still consumes admission until its work settles. */
  retain(): () => void {
    const bytes = this.active_bytes;
    this.active_bytes = 0;
    this.deferred_bytes += bytes;
    this.deferred++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.deferred_bytes -= bytes;
      this.deferred--;
      this.parse();
      this.dispatch();
      this.arm();
    };
  }
  resume(): void {
    this.paused = false;
    if (this.registration || this.dead) return;
    this.registration = this.loop.watch(this.fd, () => {
      this.read();
      this.flush();
      this.parse();
      this.dispatch();
      this.arm();
    });
    this.flush();
    this.parse();
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
    if (data.length > flow.request_bytes) throw Error("MessageTooLarge");
    this.input = data;
  }
  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.pause();
    n.probe_close(this.fd);
    this.disconnected();
  }
}
