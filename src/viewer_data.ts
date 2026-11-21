import type { Connection as Rpc } from "./rpc";
import type { Stats } from "./connection_stats";
import type * as telemetry from "./telemetry";
import * as machine_path from "./machine_path";

/** The data connection: pane contents, apart from the control connection,
 * with its own socket and compression history. */
export class Connection {
  channel: Rpc | null = null;
  viewer = 0;
  private closed = false;
  private instance = "";
  private pending: number | null = performance.now();
  private readonly ready: Promise<Error | null>;
  constructor(path: machine_path.Path, stats: Stats, trace: telemetry.Details) {
    this.ready = this.open(path, stats, trace).then(
      () => null,
      error => {
        this.close();
        return error as Error;
      },
    );
  }
  private async open(path: machine_path.Path, stats: Stats, trace: telemetry.Details) {
    const { connection, hello } = await path.open("data", stats, trace);
    if (this.closed) {
      connection.close();
      throw Error("ConnectionClosed");
    }
    this.channel = connection;
    this.instance = machine_path.compatible(hello);
    this.pending = null;
  }
  /** Whether it failed to open or has closed since, so it takes no more requests. */
  get dead(): boolean {
    return this.closed || !!this.channel?.disconnected || !!this.channel?.draining;
  }
  age(now = performance.now()): number {
    return this.pending === null ? 0 : now - this.pending;
  }
  /** The connection once open to `instance`'s daemon. Requests that need no
   * viewer, such as review's, take it before or without `bind`. */
  async openedTo(instance: string): Promise<Rpc> {
    const error = await this.ready;
    if (error) throw error;
    if (this.closed || !this.channel) throw Error("ConnectionClosed");
    if (this.instance !== instance) throw Error("StaleConnection");
    return this.channel;
  }
  async bind(link: string, instance: string): Promise<Rpc> {
    const channel = await this.openedTo(instance);
    this.pending = performance.now();
    try {
      this.viewer = (await channel.call("viewer.data", { link })).viewer;
    } finally {
      this.pending = null;
    }
    return channel;
  }
  close(): void {
    this.closed = true;
    this.pending = null;
    this.channel?.close();
  }
}
