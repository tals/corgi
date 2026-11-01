import * as rpc from "./rpc";
import type * as protocol from "./protocol";
import type { Transport } from "./mirror";
import * as viewerVersion from "./viewer_version";

/** One control connection and one for pane content and output notifications. */
export class Connection implements Transport {
  private control: rpc.Connection;
  private data: rpc.Connection | null = null;
  private watching: { viewer: number } | null = null;
  /** The daemon accepted the watch, so pane content can use the data connection. */
  private attached = false;
  /** A sync since then has caught up with changes made before the daemon would wake. */
  private watched = false;
  private closed = false;
  private listeners = new Set<(event: protocol.Event) => void>();
  constructor(readonly socket: string) {
    this.control = new rpc.Connection(socket);
    this.control.onEvent(event => this.emit(event));
    this.connectData();
  }
  private emit(event: protocol.Event): void {
    for (const listener of this.listeners) listener(event);
  }
  onEvent(listener: (event: protocol.Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private connectData(): rpc.Connection {
    if (this.closed) throw Error("ConnectionClosed");
    if (this.data) return this.data;
    const data = (this.data = new rpc.Connection(this.socket));
    data.onEvent(event => this.emit(event));
    data.socket.once("close", () => this.dropData(data));
    return data;
  }
  private dropData(data: rpc.Connection): void {
    if (this.data !== data) return;
    this.data = null;
    this.attached = false;
    this.watched = false;
    this.watching = null;
    data.close();
  }
  request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    switch (op) {
      case "viewer.sync":
        return this.sync(args[0] as protocol.RequestInput<"viewer.sync">) as Promise<protocol.Response<K>>;
      case "viewer.surfaces":
      case "viewer.image":
      case "viewer.search":
      case "viewer.pick":
      case "pane.surface":
        return this.content(op, ...args);
    }
    // Input and paste stay ordered with the commands that move or close panes.
    return this.control.request(op, ...args);
  }
  private async content<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    const data = this.attached ? this.data : null;
    if (data)
      try {
        return await data.request(op, ...args);
      } catch (error) {
        this.dropData(data);
        if (this.closed) throw error;
      }
    return this.control.request(op, ...args);
  }
  private async sync(q: protocol.RequestInput<"viewer.sync">): Promise<protocol.Response<"viewer.sync">> {
    // Unwatched, one request on control brings the view and its surfaces.
    const attached = this.attached;
    const view = await this.control.request("viewer.sync", { ...q, surfaces: !attached });
    if ("err" in view) return view;
    viewerVersion.require(view);
    if (this.watching?.viewer !== view.viewer) this.watch(view.viewer);
    if (!attached) return view;
    const frames = await this.content("viewer.surfaces");
    if ("err" in frames) return frames;
    this.watched = this.attached;
    return { ...view, surfaces: frames.surfaces };
  }
  /** Sent beside the sync; until the daemon accepts, the viewer syncs every
   * frame, and a refusal is asked again on the next sync. */
  private watch(viewer: number): void {
    const data = this.connectData(),
      watching = { viewer };
    this.watching = watching;
    this.attached = false;
    this.watched = false;
    void data.request("viewer.watch", { viewer }).then(
      reply => {
        if (this.watching !== watching) return;
        if ("err" in reply) this.watching = null;
        else this.attached = true;
      },
      () => this.dropData(data),
    );
  }
  /** Whether the daemon wakes this viewer; until then it syncs every frame. */
  watches(): boolean {
    return this.watched;
  }
  close(): void {
    this.closed = true;
    this.control.close();
    if (this.data) this.dropData(this.data);
  }
}
