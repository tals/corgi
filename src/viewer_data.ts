import { Connection as Rpc } from "./rpc";
import { Remote, startup_ms } from "./daemon_transport";
import { compatible, type Profile } from "./machines";
import type { Stats } from "./connection_stats";

/** The bulk lane has its own socket, compression history and remote SSH master. */
export class Connection {
  channel: Rpc | null = null;
  viewer = 0;
  private tunnel: Remote | null = null;
  private closed = false;
  private instance = "";
  private pending: number | null = performance.now();
  private readonly ready: Promise<Error | null>;
  constructor(profile: Profile | null, local: string, stats: Stats, fresh = false) {
    this.ready = this.open(profile, local, stats, fresh).then(
      () => null,
      error => {
        this.close();
        return error as Error;
      },
    );
  }
  private async open(profile: Profile | null, local: string, stats: Stats, fresh: boolean) {
    if (profile) {
      this.tunnel = new Remote(profile, fresh, startup_ms, "data");
      await this.tunnel.open();
    }
    if (this.closed) throw Error("ConnectionClosed");
    let established = false;
    const channel = (this.channel = new Rpc(this.tunnel?.socket ?? local, {
      compression: profile !== null,
      timeout_ms: () => (profile ? (established ? stats.timeoutMs : startup_ms) : 10000),
      stats,
      trace: { machine: profile?.name ?? "local", path: "data" },
    }));
    const hello = await channel.call("hello");
    this.instance = compatible(hello);
    established = true;
    this.pending = null;
  }
  age(now = performance.now()): number {
    return this.pending === null ? 0 : now - this.pending;
  }
  async bind(link: string, instance: string): Promise<Rpc> {
    const error = await this.ready;
    if (error) throw error;
    if (this.closed || !this.channel) throw Error("ConnectionClosed");
    if (this.instance !== instance) throw Error("StaleConnection");
    this.pending = performance.now();
    try {
      this.viewer = (await this.channel.call("viewer.data", { link })).viewer;
    } finally {
      this.pending = null;
    }
    return this.channel;
  }
  close(): void {
    this.closed = true;
    this.pending = null;
    this.channel?.close();
    this.tunnel?.close();
  }
}
