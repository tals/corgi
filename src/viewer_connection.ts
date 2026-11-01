import * as rpc from "./rpc";
import type * as protocol from "./protocol";
import type { Transport } from "./mirror";
import * as viewerVersion from "./viewer_version";

/** One control connection and one for pane content and output notifications. */
export class Connection implements Transport {
  private control: rpc.Connection;
  private data: rpc.Connection;
  private watching: { viewer: number; ready: Promise<void> } | null = null;
  private watched = false;
  constructor(readonly socket: string) {
    this.control = new rpc.Connection(socket);
    this.data = new rpc.Connection(socket);
  }
  onEvent(listener: (event: protocol.Event) => void): () => void {
    const control = this.control.onEvent(listener),
      data = this.data.onEvent(listener);
    return () => {
      control();
      data();
    };
  }
  request<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Response<K>> {
    switch (op) {
      case "viewer.sync":
        return this.sync(args[0] as protocol.RequestInput<"viewer.sync">) as Promise<protocol.Response<K>>;
      case "viewer.surfaces":
      case "viewer.image":
        return (this.watched ? this.data : this.control).request(op, ...args);
      case "viewer.search":
      case "viewer.pick":
      case "pane.surface":
        return this.data.request(op, ...args);
    }
    // Input and paste stay ordered with the commands that move or close panes.
    return this.control.request(op, ...args);
  }
  private async sync(q: protocol.RequestInput<"viewer.sync">): Promise<protocol.Response<"viewer.sync">> {
    const view = await this.control.request("viewer.sync", { ...q, surfaces: false });
    if ("err" in view) return view;
    viewerVersion.require(view);
    if (this.watching?.viewer !== view.viewer) this.watch(view.viewer);
    await this.watching!.ready;
    const frames = await this.request("viewer.surfaces");
    return "err" in frames ? frames : { ...view, surfaces: frames.surfaces };
  }
  /** Until the daemon accepts, the viewer syncs every frame; a refusal is
   * asked again on the next sync. */
  private watch(viewer: number): void {
    const watching = { viewer, ready: Promise.resolve() };
    this.watching = watching;
    this.watched = false;
    watching.ready = this.data.call("viewer.watch", { viewer }).then(
      () => {
        if (this.watching === watching) this.watched = true;
      },
      () => {
        if (this.watching === watching) this.watching = null;
      },
    );
  }
  /** Whether the daemon wakes this viewer; until then it syncs every frame. */
  watches(): boolean {
    return this.watched;
  }
  close(): void {
    this.control.close();
    this.data.close();
  }
}
