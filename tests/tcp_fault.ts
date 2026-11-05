import { createConnection, createServer, type Socket } from "node:net";

type Mode = "healthy" | "blackhole" | "replies";
/** A userspace cable pull. Keep TCP open while withholding traffic, or sever it. No root/firewall required. */
export class TcpFault {
  private mode: Mode = "healthy";
  private strand_next = 0;
  private pairs = new Set<{ client: Socket; upstream: Socket; upload: number; download: number; stranded: boolean }>();
  private server = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: this.upstream });
    const pair = { client, upstream, upload: 0, download: 0, stranded: this.strand_next > 0 };
    if (this.strand_next > 0) this.strand_next--;
    const rate = this.bytes_per_second;
    const scheduled = { upload: 0, download: 0 };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    this.accepted++;
    this.pairs.add(pair);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const close = () => {
      for (const timer of timers) clearTimeout(timer);
      client.destroy();
      upstream.destroy();
      this.pairs.delete(pair);
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    const forward = (source: Socket, target: Socket, bytes: Buffer) => {
      if (!this.latency_ms && !rate) {
        if (!target.write(bytes)) source.pause();
        return;
      }
      const direction = source === client ? "upload" : "download";
      const now = performance.now();
      const due = rate
        ? (scheduled[direction] = Math.max(now + this.latency_ms, scheduled[direction]) + (bytes.length * 1000) / rate)
        : now + this.latency_ms;
      pair[direction] += bytes.length;
      if (pair[direction] >= 1024 * 1024) source.pause();
      const timer = setTimeout(() => {
        timers.delete(timer);
        pair[direction] -= bytes.length;
        if (!target.destroyed) target.write(bytes);
        this.flow(pair);
      }, due - now);
      timers.add(timer);
    };
    client.on("data", bytes => {
      this.uploaded += bytes.length;
      forward(client, upstream, bytes);
    });
    upstream.on("data", bytes => {
      this.downloaded += bytes.length;
      forward(upstream, client, bytes);
    });
    client.on("drain", () => {
      if (this.mode === "healthy" && !pair.stranded) upstream.resume();
    });
    upstream.on("drain", () => {
      if (this.mode !== "blackhole" && !pair.stranded) client.resume();
    });
    this.flow(pair);
  });
  accepted = 0;
  uploaded = 0;
  downloaded = 0;
  port = 0;
  latency_ms = 0;
  /** Applies to new connections only, so an upload can be slow beside a healthy viewer. */
  bytes_per_second = 0;
  constructor(private readonly upstream: number) {}
  get withheld(): number {
    return [...this.pairs].reduce((bytes, pair) => bytes + pair.upstream.readableLength, 0);
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw Error("NoProxyAddress");
    this.port = address.port;
  }
  set(mode: Mode): void {
    this.mode = mode;
    for (const pair of this.pairs) this.flow(pair);
  }
  private flow({
    client,
    upstream,
    upload,
    download,
    stranded,
  }: {
    client: Socket;
    upstream: Socket;
    upload: number;
    download: number;
    stranded: boolean;
  }): void {
    if (stranded || this.mode === "blackhole" || upload >= 1024 * 1024) client.pause();
    else if (!upstream.writableNeedDrain) client.resume();
    if (stranded || this.mode !== "healthy" || download >= 1024 * 1024) upstream.pause();
    else if (!client.writableNeedDrain) upstream.resume();
  }
  /** The network changed: connections open now go silent for good, while
   * new ones get through. */
  /** Lose the next handshakes too, so recovery itself can fail deterministically. */
  strandNext(count: number): void {
    this.strand_next = count;
  }
  strand(): void {
    for (const pair of this.pairs) {
      pair.stranded = true;
      this.flow(pair);
    }
  }
  cut(): void {
    for (const { client, upstream } of this.pairs) {
      client.destroy();
      upstream.destroy();
    }
    this.pairs.clear();
  }
  async close(): Promise<void> {
    this.cut();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
