import * as rpc from "./rpc";
import type * as protocol from "./protocol";
import type { Transport } from "./mirror";
import * as viewerVersion from "./viewer_version";

/** One control connection and one for pane content and output notifications. */
export class Connection implements Transport {
  private control: rpc.Connection;
  private data: rpc.Connection;
  private watching: Promise<unknown> | null = null;
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
      case "viewer.search":
      case "viewer.pick":
      case "pane.surface":
      case "pane.paste":
        return this.data.request(op, ...args);
      case "session.command": {
        const q = args[0] as protocol.RequestInput<"session.command">;
        if ("pane.input" in q.command) return this.data.request(op, ...args);
      }
    }
    return this.control.request(op, ...args);
  }
  private async sync(q: protocol.RequestInput<"viewer.sync">): Promise<protocol.Response<"viewer.sync">> {
    const view = await this.control.request("viewer.sync", { ...q, surfaces: false });
    if ("err" in view) return view;
    viewerVersion.require(view);
    this.watching ??= this.data.call("viewer.watch", { viewer: view.viewer });
    await this.watching;
    const frames = await this.data.request("viewer.surfaces");
    return "err" in frames ? frames : { ...view, surfaces: frames.surfaces };
  }
  close(): void {
    this.control.close();
    this.data.close();
  }
}
