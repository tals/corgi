import { Connection } from "./rpc";
import type { Reply, RequestInput } from "./protocol";
import * as json from "./json";
import * as viewerVersion from "./viewer_version";
import * as surface from "./pane/surface";

type Frame = Reply<"viewer.sync">;
/** One coalesced frame and bounded, independently acknowledged writes. No replay. */
export class Stream {
  private frame: Frame | null = null;
  /** The frame waiting changes something, rather than only answering. */
  private news = false;
  /** What the last frame said of the bell and the hashes. */
  private seen = "";
  private sequence = 0;
  private configured = "";
  private pending = false;
  private next = 0;
  private failure: Error | null = null;
  private bytes = 0;
  private writes = new Map<Promise<void>, number>();
  private last = performance.now();
  private confirmed = false;
  private retained = new Map<number, surface.View>();
  private received = 0n;
  constructor(
    private readonly connection: Connection,
    private readonly changed: () => void = () => {},
    private readonly incremental = false,
    private readonly data = connection,
  ) {
    connection.onClose(changed);
    if (data !== connection) data.onClose(changed);
    data.onEvent(value => {
      try {
        if (
          !value ||
          typeof value !== "object" ||
          !("type" in value) ||
          (value.type !== "viewer.frame" && value.type !== "viewer.stream")
        )
          return;
        if (!("sequence" in value) || typeof value.sequence !== "number" || !("view" in value))
          throw Error("InvalidStreamFrame");
        viewerVersion.require(value.view);
        const serial = "frame" in value && value.frame !== undefined ? BigInt(value.frame) : null;
        this.receive(value.sequence, value.view as Frame, serial);
      } catch (error) {
        this.failure = error as Error;
        this.changed();
      }
    });
  }
  private receive(sequence: number, frame: Frame, serial: bigint | null): void {
    viewerVersion.require(frame);
    this.last = performance.now();
    if (sequence !== this.sequence) return;
    if (serial !== null) {
      if (!this.incremental || serial !== this.received + 1n) throw Error("InvalidStreamFrame");
      const surfaces = frame.surfaces.map(value => surface.view(value));
      for (const value of surfaces) this.retained.set(value.surface.pane, value);
      for (const patch of frame.patches ?? []) {
        const value = surface.apply(this.retained.get(patch.surface.pane), patch);
        this.retained.set(value.surface.pane, value);
        surfaces.push(value);
      }
      frame = { ...frame, surfaces, patches: undefined };
      this.received = serial;
      // Decode every delta before coalescing. The next frame may use it as
      // its base even when the UI never displays this intermediate frame.
      void this.receipt(sequence).catch(error => {
        this.failure = error;
        this.changed();
      });
    } else if (this.incremental) throw Error("InvalidStreamFrame");
    // A heartbeat's answer that changes nothing leaves an idle viewer asleep.
    const seen = `${frame.bell_seq} ${frame.session_hash} ${frame.resources_hash}`;
    const news =
      !this.confirmed ||
      frame.session !== null ||
      frame.resources !== null ||
      frame.surfaces.length > 0 ||
      frame.controls.length > 0 ||
      frame.detach ||
      seen !== this.seen;
    this.seen = seen;
    this.confirmed = true;
    if (this.frame) {
      const surfaces = new Map(this.frame.surfaces.map(surface => [surface.surface.pane, surface]));
      for (const surface of frame.surfaces) surfaces.set(surface.surface.pane, surface);
      frame = {
        ...frame,
        session: frame.session ?? this.frame.session,
        resources: frame.resources ?? this.frame.resources,
        surfaces: [...surfaces.values()],
      };
    }
    this.frame = frame;
    if (!news) return;
    this.news = true;
    this.changed();
  }
  /** The frame waiting, and whether it changes anything. */
  take(): { frame: Frame; news: boolean } | null {
    const frame = this.frame,
      news = this.news;
    this.frame = null;
    this.news = false;
    return frame && { frame, news };
  }
  reset(): void {
    this.frame = null;
    this.news = false;
    this.configured = "";
    this.confirmed = false;
    this.retained.clear();
    this.received = 0n;
    // In-flight frames belong to the model before a command's explicit refresh.
    this.sequence++;
  }
  get fresh(): boolean {
    return this.confirmed;
  }
  age(now = performance.now()): number {
    return now - Math.min(this.last, ...this.writes.values());
  }
  check(): void {
    if (this.failure) throw this.failure;
    if (this.connection.failure) throw this.connection.failure;
    if (this.data.failure) throw this.data.failure;
    if (this.age() >= (this.connection.timeout_ms || 10_000)) throw Error("RequestTimedOut");
  }
  send(start: () => Promise<void>, bytes = 0): void {
    if (this.connection.draining) return;
    if (this.bytes + bytes > 1024 * 1024 || this.writes.size >= 64) throw Error("InputBackpressure");
    this.bytes += bytes;
    const task = start();
    this.writes.set(task, performance.now());
    void task
      .catch(error => {
        this.failure = error;
        this.changed();
      })
      .finally(() => {
        this.bytes -= bytes;
        this.writes.delete(task);
      });
  }
  /** When the next `configure` sends the request again, which keeps the
   * stream answering; null while one is out. */
  due(): number | null {
    return this.pending ? null : this.next;
  }
  private async receipt(sequence: number, active = false): Promise<void> {
    if (this.connection.draining) return;
    const reply = await this.connection.call("viewer.receipt", { sequence, frame: this.received, active });
    if (sequence !== this.sequence) return;
    if (this.data === this.connection) this.last = performance.now();
    // Handoff restores the viewer but deliberately discards stream caches.
    if (!reply.stream) {
      this.reset();
      this.next = 0;
      this.changed();
    }
  }
  configure(request: RequestInput<"viewer.sync">, selection: number): void {
    this.check();
    if (this.connection.draining) return;
    const key = json.stringify({
      ...request,
      selection,
      session_hash: null,
      resources_hash: null,
      active: false,
      interests: request.interests.map(interest => ({ ...interest, known: null })),
    });
    const changed = key !== this.configured;
    if (this.pending || (!changed && performance.now() < this.next)) return;
    if (changed) {
      this.sequence++;
      this.frame = null;
      this.confirmed = false;
      this.retained.clear();
      this.received = 0n;
    }
    if (this.incremental ? changed : !this.configured)
      request = {
        ...request,
        session_hash: null,
        resources_hash: null,
        interests: request.interests.map(interest => ({ ...interest, known: null })),
      };
    this.configured = key;
    this.pending = true;
    const sequence = this.sequence;
    const task =
      this.incremental && !changed
        ? this.receipt(sequence, request.active)
        : this.connection
            .call(this.data === this.connection ? "viewer.stream" : "viewer.stream.configure", {
              ...request,
              sequence,
              incremental: this.incremental,
            })
            .then(reply => {
              viewerVersion.require(reply);
            });
    void task
      // A daemon on another viewer protocol says so in its reply.
      .catch(error => {
        this.failure = error;
        this.changed();
      })
      .finally(() => {
        this.pending = false;
        this.next = performance.now() + 500;
      });
  }
}
