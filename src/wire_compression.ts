import * as zlib from "node:zlib";
import * as telemetry from "./telemetry";

const capacity = 4 * 1024 * 1024;
/** One bounded, live history per direction. A new transport always starts fresh. */
export class Channel {
  private encoder = zlib.createZstdCompress({
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_windowLog]: 20 },
    flush: zlib.constants.ZSTD_e_flush,
  });
  private decoder = zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: 20 } });
  private queue: { data: Buffer; done?: (bytes: number) => void }[] = [];
  private encoding = false;
  private stopped = false;
  private emitted = 0;
  pending = 0;
  private incoming = 0;
  private readers: (() => void)[] = [];
  constructor(
    private readonly write: (bytes: Buffer) => void,
    private readonly read: (bytes: Buffer) => void,
    private readonly failed: (error: Error) => void,
  ) {
    this.encoder.on("data", (bytes: Buffer) => {
      if (this.stopped) return;
      this.emitted += bytes.length;
      this.write(bytes);
    });
    this.decoder.on("data", (bytes: Buffer) => {
      if (!this.stopped) this.read(bytes);
    });
    this.encoder.on("error", error => this.fail(error));
    this.decoder.on("error", error => this.fail(error));
  }
  private fail(error: Error): void {
    if (this.stopped) return;
    this.close();
    this.failed(error);
  }
  encode(data: Buffer, done?: (bytes: number) => void): void {
    if (this.stopped) return;
    if (this.pending + data.length > capacity) return this.fail(Error("MessageTooLarge"));
    this.pending += data.length;
    this.queue.push({ data, done });
    this.next();
  }
  private next(): void {
    if (this.encoding || this.stopped) return;
    const item = this.queue.shift();
    if (!item) return;
    this.encoding = true;
    const before = this.emitted,
      started = telemetry.begin();
    this.encoder.write(item.data, error => {
      if (error) return this.fail(error);
      if (this.stopped) return;
      this.pending -= item.data.length;
      this.encoding = false;
      const bytes = this.emitted - before;
      telemetry.end("wire.compress", started, bytes, { raw_bytes: item.data.length });
      item.done?.(bytes);
      this.next();
    });
  }
  decode(data: Buffer): void {
    if (this.stopped) return;
    if (this.incoming + data.length > capacity) return this.fail(Error("MessageTooLarge"));
    this.incoming += data.length;
    this.decoder.write(data, error => {
      this.incoming -= data.length;
      if (!this.incoming) for (const done of this.readers.splice(0)) done();
      if (error) this.fail(error);
    });
  }
  drainInput(): Promise<void> {
    return this.incoming && !this.stopped ? new Promise(resolve => this.readers.push(resolve)) : Promise.resolve();
  }
  close(): void {
    this.stopped = true;
    for (const done of this.readers.splice(0)) done();
    this.queue = [];
    this.pending = 0;
    this.encoder.destroy();
    this.decoder.destroy();
  }
}
