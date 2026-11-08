import type { Wait as StartupWait } from "./startup";
import * as telemetry from "./telemetry";
import { n, ptr, ReadyLoop, READ, WRITE } from "./native_bridge";
import * as json from "./json";
import * as wire_compression from "./wire_compression";
import * as wire_websocket from "./wire_websocket";
import * as errors from "./errors";
import type { Control } from "./protocol";
import type { Interest } from "./viewer_protocol";
import type { Subscription } from "./launch_service";
import type { Link } from "./link";
import type { Frames } from "./viewer_stream";
/** A request owns its response even when it completes after another request. */
export class Reply {
  constructor(
    private client: Client,
    readonly id: number | null = null,
    private readonly sent?: (value: object) => void,
  ) {}
  send(value: object): void {
    if (this.sent) this.sent(value);
    else this.client.queue(this.id === null ? value : { ...value, request_id: this.id });
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
  stream: {
    delivery?: Frames;
    sequence: number;
    session_hash: bigint | null;
    resources_hash: bigint | null;
    sent: number;
    wake: bigint;
  } | null = null;
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
  resource_observer = false;
  dead = false;
  /** The link this connection carries, once the client opened or resumed one. */
  link: Link | null = null;
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
  private frame_timer: ReturnType<typeof setTimeout> | null = null;
  private frame_pending: (() => void) | null = null;
  private frame_deadline = 0;
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
  private codec: wire_compression.Channel | null = null;
  private websocket: wire_websocket.Server | null = null;
  private waiting_for_close = false;
  private compressed_overhead = 0;
  savedWebSocket(): wire_websocket.State | null {
    return this.websocket?.save() ?? null;
  }
  restoreWebSocket(value: unknown): void {
    this.websocket = new wire_websocket.Server(
      bytes => this.writeRaw(bytes),
      bytes => this.decode(bytes),
      wire_websocket.state(value),
    );
  }
  get compressed(): boolean {
    return this.codec !== null;
  }
  get canCompress(): boolean {
    return (
      !this.codec &&
      this.http === "no" &&
      this.lines === 1 &&
      this.pending.length === 0 &&
      !this.input.length &&
      (!this.websocket || this.websocket.idle)
    );
  }
  get queued(): number {
    return this.output.length - this.sent + (this.codec?.pending ?? 0);
  }
  compress(): void {
    if (this.codec || this.http !== "no") throw Error("InvalidCompressionState");
    this.codec = new wire_compression.Channel(
      bytes => this.write(bytes),
      bytes => this.receiveBytes(bytes),
      () => this.close(),
    );
  }
  async prepareHandoff(): Promise<void> {
    if (!this.compressed || !this.viewer) return;
    this.cancelFrame();
    this.stream = null;
    this.queue({ type: "viewer.reconnect" });
    const until = performance.now() + 1000;
    while (!this.dead && this.queued && performance.now() < until) await Bun.sleep(1);
  }
  async rolledBack(): Promise<void> {
    if (!this.websocket || this.dead) return;
    // Let the peer read and acknowledge Close before dropping a socket with unread receipts.
    this.waiting_for_close = true;
    this.websocket.fail(wire_websocket.rolled_back);
    this.resume();
    const until = performance.now() + 1000;
    while (!this.dead && performance.now() < until) await Bun.sleep(1);
    this.close();
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
    const encode_started = telemetry.begin();
    const bytes = Buffer.from(json.stringify(value) + "\n");
    telemetry.end("wire.encode", encode_started, bytes.length);
    const delivery = this.stream?.delivery;
    const frame =
      value && typeof value === "object" && "frame" in value && typeof value.frame === "bigint" ? value.frame : null;
    if (this.codec)
      this.codec.encode(bytes, count => {
        const wire_bytes = count + this.compressed_overhead;
        this.compressed_overhead = 0;
        if (frame !== null) delivery?.encoded(frame, wire_bytes);
        this.armFrame();
      });
    else {
      const wire_bytes = this.write(bytes);
      if (frame !== null) delivery?.encoded(frame, wire_bytes);
    }
  }
  private write(bytes: Buffer): number {
    if (this.websocket?.closing) return 0;
    const framed = this.websocket ? wire_websocket.frame(bytes) : bytes;
    if (this.codec) this.compressed_overhead += framed.length - bytes.length;
    this.writeRaw(framed);
    return framed.length;
  }
  private writeRaw(bytes: Buffer): void {
    if (this.dead) return;
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
  deferFrame(deadline: number, send: () => void): void {
    this.frame_pending = send;
    this.frame_deadline = deadline;
    this.armFrame();
  }
  cancelFrame(): void {
    if (this.frame_timer !== null) clearTimeout(this.frame_timer);
    this.frame_timer = this.frame_pending = null;
  }
  private armFrame(): void {
    if (this.paused || this.dead || this.queued || this.frame_timer !== null || !this.frame_pending) return;
    this.frame_timer = setTimeout(
      () => {
        const send = this.frame_pending;
        this.frame_timer = this.frame_pending = null;
        send?.();
      },
      Math.max(0, this.frame_deadline - Date.now()),
    );
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
      if (this.http === "replied" || (this.websocket?.closing && !this.waiting_for_close)) this.close();
      else this.drained(this);
      this.armFrame();
    }
  }
  private read(): void {
    for (let i = 0; i < 8 && !this.dead; i++) {
      const count = n.probe_read(this.fd, ptr(this.scratch), this.scratch.length);
      if (count > 0) {
        const bytes = Buffer.from(this.scratch.subarray(0, count));
        try {
          if (this.websocket) this.websocket.receive(bytes);
          else this.decode(bytes);
        } catch (error) {
          this.websocket?.fail(errors.is(error, "MessageTooLarge") ? 1009 : 1002);
          if (!this.websocket?.closing) this.close();
          return;
        }
      } else if (count === -4) continue;
      else if (count === -11 || count === -35) break;
      else {
        this.close();
        return;
      }
    }
  }
  private decode(bytes: Buffer): void {
    if (this.codec) this.codec.decode(bytes);
    else this.receiveBytes(bytes);
  }
  private receiveBytes(bytes: Buffer): void {
    if (this.dead) return;
    this.input = Buffer.concat([this.input, bytes]);
    if (this.input.length > 4 * 1024 * 1024) {
      this.close();
      return;
    }
    if (!this.websocket && !this.lines && this.http === "no" && this.input.subarray(0, 4).toString() === "GET ") {
      const input = this.input;
      this.input = Buffer.alloc(0);
      this.restoreWebSocket({ ready: false, closing: false, input: "", fragment: null });
      this.websocket!.receive(input);
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
      return;
    }
    for (;;) {
      const end = this.input.indexOf(10);
      if (end < 0) break;
      const line = this.input.subarray(0, end).toString();
      this.input = Buffer.from(this.input.subarray(end + 1));
      this.lines++;
      try {
        if (this.pending.length >= 512) {
          this.close();
          return;
        }
        this.touched = Date.now();
        this.pending.push(json.parse(line));
        this.dispatch();
      } catch {
        this.queue({ err: "InvalidJson" });
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
    if (this.paused || this.dead || this.busy || this.headless_start || !this.pending.length) return;
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
    this.cancelFrame();
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
  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.codec?.close();
    this.pause();
    n.probe_close(this.fd);
    this.disconnected();
  }
}
