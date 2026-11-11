import type { Wait as StartupWait } from "./startup";
import * as telemetry from "./telemetry";
import * as json from "./json";
import * as wire_compression from "./wire_compression";
import type { Control } from "./protocol";
import type { Interest } from "./viewer_protocol";
import type { Subscription } from "./launch_service";
import type * as link from "./link";
import type * as viewer_stream from "./viewer_stream";
/** Where a client's bytes go: a WebSocket, or a test's record. */
export interface Transport {
  send(bytes: Buffer): void;
  /** Bytes sent but not yet written to the socket. */
  readonly buffered: number;
  close(code?: number, reason?: string): void;
}
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
    delivery?: viewer_stream.Frames;
    separate?: boolean;
    sequence: number;
    session_hash: bigint | null;
    resources_hash: bigint | null;
    sent: number;
    wake: bigint;
    heartbeat: number;
  } | null = null;
  watching = false;
  stream_data = false;
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
  link: link.Link | null = null;
  touched = Date.now();
  input: Buffer = Buffer.alloc(0);
  /** Requests received; the first runs while the rest wait. */
  pending: any[] = [];
  private lines = 0;
  private busy = false;
  private paused = false;
  private frame_timer: ReturnType<typeof setTimeout> | null = null;
  private frame_pending: (() => void) | null = null;
  private frame_deadline = 0;
  private codec: wire_compression.Channel | null = null;
  constructor(
    /** Where its bytes go; null for a client with no connection, as tests make. */
    private readonly transport: Transport | null,
    readonly receive: (client: Client, value: any) => void,
    readonly disconnected: () => void,
    start = true,
    readonly drained: (client: Client) => void = () => {},
    /** Answers an HTTP request: the client takes one envelope and replies once. */
    private respond: ((value: unknown) => void) | null = null,
  ) {
    this.paused = !start;
  }
  /** An HTTP request instead of a connection: `corgi-hook` and management calls. */
  get http(): boolean {
    return this.respond !== null || this.answered;
  }
  private answered = false;
  get compressed(): boolean {
    return this.codec !== null;
  }
  /** Only a connection's first request, alone, may switch it to compression. */
  get canCompress(): boolean {
    return !this.codec && !this.http && this.lines === 1 && this.pending.length === 0 && !this.input.length;
  }
  get queued(): number {
    return (this.transport?.buffered ?? 0) + (this.codec?.pending ?? 0);
  }
  compress(): void {
    if (this.codec || this.http) throw Error("InvalidCompressionState");
    this.codec = new wire_compression.Channel(
      bytes => this.write(bytes),
      bytes => this.receiveBytes(bytes),
      () => this.close(),
    );
  }
  queue(value: unknown, delivery = this.stream?.delivery): void {
    if (this.dead) return;
    if (this.http) {
      const respond = this.respond;
      this.respond = null;
      this.answered = true;
      respond?.(value);
      this.closed();
      return;
    }
    const encode_started = telemetry.begin();
    const bytes = Buffer.from(json.stringify(value) + "\n");
    telemetry.end("wire.encode", encode_started, bytes.length);
    const frame =
      value && typeof value === "object" && "frame" in value && typeof value.frame === "bigint" ? value.frame : null;
    if (this.codec)
      this.codec.encode(bytes, count => {
        if (frame !== null) delivery?.encoded(frame, count);
        this.armFrame();
      });
    else {
      this.write(bytes);
      if (frame !== null) delivery?.encoded(frame, bytes.length);
    }
  }
  private write(bytes: Buffer): void {
    if (this.dead || !this.transport) return;
    if (this.transport.buffered + bytes.length > 4 * 1024 * 1024) {
      this.close();
      return;
    }
    this.transport.send(bytes);
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
  /** The transport wrote what it had queued. */
  flushed(): void {
    if (this.dead) return;
    this.drained(this);
    this.armFrame();
  }
  /** Bytes from the connection: JSON lines, compressed once negotiated. */
  read(bytes: Buffer): void {
    if (this.dead) return;
    if (this.codec) this.codec.decode(bytes);
    else this.receiveBytes(bytes);
  }
  /** An HTTP request's envelope. */
  request(value: unknown): void {
    this.touched = Date.now();
    this.pending.push(value);
    this.dispatch();
  }
  private receiveBytes(bytes: Buffer): void {
    if (this.dead) return;
    this.input = Buffer.concat([this.input, bytes]);
    if (this.input.length > 4 * 1024 * 1024) {
      this.close();
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
    if (this.dead) return;
    this.paused = false;
    this.dispatch();
    this.armFrame();
  }
  pause(): void {
    this.paused = true;
    this.cancelFrame();
  }
  /** Whether a request arrived that hasn't started, as during a handoff:
   * one held, or queued behind another job, which takes it when it runs. */
  get waiting(): boolean {
    return this.pending.length > 0;
  }
  /** Closes the connection, with a WebSocket close `code` when it has one. */
  close(code?: number, reason?: string): void {
    if (this.dead) return;
    this.transport?.close(code, reason);
    this.closed();
  }
  /** The connection went. */
  closed(): void {
    if (this.dead) return;
    this.dead = true;
    this.codec?.close();
    this.pause();
    this.disconnected();
  }
}
