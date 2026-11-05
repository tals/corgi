import { Connection } from "./rpc";
import type { Reply, RequestInput } from "./protocol";
import * as json from "./json";
import * as viewerVersion from "./viewer_version";

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
  constructor(
    private readonly connection: Connection,
    private readonly changed: () => void = () => {},
  ) {
    connection.socket.once("close", changed);
    connection.onEvent(value => {
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
        this.receive(value.sequence, value.view as Frame);
      } catch (error) {
        this.failure = error as Error;
        this.changed();
      }
    });
  }
  private receive(sequence: number, frame: Frame): void {
    viewerVersion.require(frame);
    this.last = performance.now();
    if (sequence !== this.sequence) return;
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
    if (this.connection.socket.destroyed) throw Error("ConnectionClosed");
    if (this.age() >= 10_000) throw Error("RequestTimedOut");
  }
  send(start: () => Promise<void>, bytes = 0): void {
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
  configure(request: RequestInput<"viewer.sync">, selection: number): void {
    this.check();
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
    }
    if (!this.configured)
      request = {
        ...request,
        session_hash: null,
        resources_hash: null,
        interests: request.interests.map(interest => ({ ...interest, known: null })),
      };
    this.configured = key;
    this.pending = true;
    const sequence = this.sequence;
    void this.connection
      .call("viewer.stream", { ...request, sequence })
      // A daemon on another viewer protocol says so in its reply.
      .then(reply => {
        viewerVersion.require(reply);
      })
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
