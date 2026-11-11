import { isAbsolute } from "node:path";
import * as json from "./json";

export const max_bytes = 32 * 1024 * 1024;
export type Progress = (received: number, total: number) => void;

/** Receipts describe bytes read by the remote process, never the SSH send buffer. */
export async function receive(source: AsyncIterable<Uint8Array>, report: (received: number) => void): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0,
    reported = 0;
  report(0);
  for await (const chunk of source) {
    size += chunk.length;
    if (size > max_bytes) throw Error("StreamTooLong");
    chunks.push(chunk);
    if (size - reported >= 64 * 1024) report((reported = size));
  }
  if (reported !== size) report(size);
  return Buffer.concat(chunks);
}

/** Bounded newline records; older helpers send only the final path. */
export class Receipts {
  private output = "";
  private offset = 0;
  private received: number | null = null;
  constructor(
    private readonly total: number,
    private readonly progress: Progress = () => {},
  ) {}
  feed(chunk: string): void {
    this.output += chunk;
    if (Buffer.byteLength(this.output) > 65536) throw Error("ImageUploadFailed");
    for (;;) {
      const end = this.output.indexOf("\n", this.offset);
      if (end < 0) return;
      const line = this.output.slice(this.offset, end);
      this.offset = end + 1;
      let value: unknown;
      try {
        value = json.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || !("received" in value)) continue;
      const received = value.received;
      if (
        typeof received !== "number" ||
        !Number.isSafeInteger(received) ||
        received < (this.received ?? 0) ||
        received > this.total
      )
        throw Error("InvalidImageProgress");
      this.received = received;
      this.progress(received, this.total);
    }
  }
  finish(): string {
    if (this.received !== null && this.received !== this.total) throw Error("ImageUploadFailed");
    const value: unknown = json.parse(this.output.trim().split("\n").at(-1) ?? "");
    if (
      !value ||
      typeof value !== "object" ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !isAbsolute(value.path) ||
      /[\x00-\x1f\x7f]/.test(value.path)
    )
      throw Error("ImageUploadFailed");
    return value.path;
  }
}
