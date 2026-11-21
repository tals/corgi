// One transfer per duplex stream. The inner signature/delta bytes are librsync compatible.
import * as fs from "node:fs";
import * as timers from "node:timers/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as zlib from "node:zlib";
import * as port from "./fast_rsync";

export type Transport = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
export type Progress = (stage: "signature" | "prepare" | "upload", sent: number, total: number) => void;
type Manifest = { version: 1; bytes: number; sha256: string; block: number };
const maximumFrame = 1024 * 1024;
const maximum = 512 * 1024 * 1024;
const maximumSignature = 16 * 1024 * 1024;
const buffer = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

class Frames {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private pending: Buffer = Buffer.alloc(0);
  sent = 0;
  received = 0;
  constructor(transport: Transport) {
    this.reader = transport.readable.getReader();
    this.writer = transport.writable.getWriter();
  }
  private async bytes(size: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(size);
    let n = 0;
    while (n < size) {
      if (!this.pending.length) {
        const next = await this.reader.read();
        if (next.done) throw Error("UnexpectedEOF");
        this.pending = buffer(next.value);
      }
      const take = Math.min(size - n, this.pending.length);
      this.pending.copy(result, n, 0, take);
      n += take;
      this.pending = this.pending.subarray(take);
    }
    this.received += size;
    return result;
  }
  async read(maximum: number): Promise<Buffer> {
    const size = (await this.bytes(4)).readUInt32BE();
    if (size > maximum) throw Error("OversizedFrame");
    return this.bytes(size);
  }
  async write(data: Uint8Array): Promise<void> {
    await this.writeBytes(frame(data));
  }
  async writeBytes(bytes: Uint8Array): Promise<void> {
    await this.writer.write(bytes);
    this.sent += bytes.byteLength;
  }
  async dispose(error?: unknown): Promise<void> {
    if (error) await Promise.allSettled([this.reader.cancel(error), this.writer.abort(error)]);
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
}
function frame(data: Uint8Array): Buffer {
  const bytes = Buffer.allocUnsafe(4 + data.byteLength);
  bytes.writeUInt32BE(data.byteLength);
  bytes.set(data, 4);
  return bytes;
}

/** Keep small dev patches in memory. Spool large ones once so upload progress has an exact total. */
class Patch {
  length = 0;
  private chunks: Buffer[] = [];
  private directory: string | null = null;
  private fd: number | null = null;
  append(bytes: Buffer): void {
    this.length += bytes.length;
    if (this.fd === null && this.length > 4 * 1024 * 1024) {
      this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-delta-"));
      this.fd = fs.openSync(path.join(this.directory, "patch"), "wx", 0o600);
      for (const chunk of this.chunks) fs.writeFileSync(this.fd, chunk);
      this.chunks = [];
    }
    if (this.fd === null) this.chunks.push(bytes);
    else fs.writeFileSync(this.fd, bytes);
  }
  async *read(): AsyncGenerator<Uint8Array> {
    if (this.directory) yield* fs.createReadStream(path.join(this.directory, "patch"), { highWaterMark: 65536 });
    else
      for (const chunk of this.chunks)
        for (let offset = 0; offset < chunk.length; offset += 65536) yield chunk.subarray(offset, offset + 65536);
  }
  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
function manifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null) throw Error("InvalidManifest");
  const m = value as Partial<Manifest>;
  if (
    m.version !== 1 ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes! < 0 ||
    m.bytes! > maximum ||
    !Number.isInteger(m.block) ||
    m.block! < 1024 ||
    m.block! > 65536 ||
    typeof m.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.sha256)
  )
    throw Error("InvalidManifest");
  return m as Manifest;
}
const compress = (data: Uint8Array) => Bun.zstdCompressSync(data, { level: 1 });
const decompress = (data: Uint8Array, limit: number) => zlib.zstdDecompressSync(data, { maxOutputLength: limit });

/** Delta frames are bounded to 1 MiB; decoded output chunks stay within 64 KiB. */
export async function receive(
  transport: Transport,
  basis: Buffer,
  write: (bytes: Buffer) => void | Promise<void>,
  expected?: string,
): Promise<{ sha256: string; bytes: number; signature_seconds: number; apply_seconds: number }> {
  const frames = new Frames(transport);
  let failure: unknown;
  try {
    const info = manifest(JSON.parse((await frames.read(1024)).toString()));
    if (expected !== undefined && info.sha256 !== expected) throw Error("UnexpectedArtifact");
    if (12 + Math.ceil(basis.length / info.block) * 20 > maximumSignature) throw Error("SignatureTooLarge");
    let tick = performance.now();
    await frames.write(compress(port.signature(basis, info.block)));
    const signatureSeconds = (performance.now() - tick) / 1000;
    tick = performance.now();
    const decoder = new port.Decoder(basis, info.bytes),
      hash = new Bun.CryptoHasher("sha256");
    for (;;) {
      const compressed = await frames.read(maximumFrame + 1024);
      if (!compressed.length) break;
      for (const bytes of decoder.write(decompress(compressed, maximumFrame))) {
        hash.update(bytes);
        await write(bytes);
      }
    }
    const bytes = decoder.finish(),
      actual = hash.digest("hex");
    if (bytes !== info.bytes || actual !== info.sha256) throw Error("HashMismatch");
    const result = {
      sha256: actual,
      bytes,
      signature_seconds: signatureSeconds,
      apply_seconds: (performance.now() - tick) / 1000,
    };
    await frames.write(Buffer.from(JSON.stringify(result)));
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await frames.dispose(failure);
  }
}

export async function send(
  transport: Transport,
  data: Buffer,
  sha256: string,
  progress?: Progress,
  {
    block = 32768,
    frameSize = 256 * 1024,
    signal,
    beforeFinish,
  }: { block?: number; frameSize?: number; signal?: AbortSignal; beforeFinish?: () => void } = {},
) {
  if (!Number.isInteger(frameSize) || frameSize < 1024 || frameSize > maximumFrame) throw Error("InvalidFrameSize");
  const info = manifest({ version: 1, bytes: data.length, sha256, block });
  const frames = new Frames(transport),
    start = performance.now();
  const patch = new Patch();
  let failure: unknown;
  try {
    signal?.throwIfAborted();
    progress?.("signature", 0, 0);
    await frames.write(Buffer.from(JSON.stringify(info)));
    const signature = decompress(await frames.read(maximumSignature + 1024), maximumSignature);
    if (signature.length < 12 || signature.readUInt32BE(4) !== block || signature.readUInt32BE(8) !== 16)
      throw Error("InvalidSignature");
    progress?.("prepare", 0, 0);
    const signatureSeconds = (performance.now() - start) / 1000;
    const output = Buffer.allocUnsafe(frameSize);
    let used = 0,
      rawBytes = 0,
      patchBytes = 0,
      patchFrames = 0;
    const tick = performance.now();
    const flush = () => {
      if (!used) return;
      const compressed = compress(output.subarray(0, used));
      patch.append(frame(compressed));
      rawBytes += used;
      patchBytes += compressed.length;
      patchFrames++;
      used = 0;
    };
    for (const piece of port.deltaChunks(signature, data)) {
      if (!piece.length) {
        await timers.setImmediate();
        signal?.throwIfAborted();
        continue;
      }
      let p = 0;
      while (p < piece.length) {
        const n = Math.min(output.length - used, piece.length - p);
        piece.copy(output, used, p, p + n);
        used += n;
        p += n;
        if (used === output.length) {
          flush();
          await timers.setImmediate();
          signal?.throwIfAborted();
        }
      }
    }
    signal?.throwIfAborted();
    flush();
    const total = patch.length + 4; // The empty frame finishes the transfer.
    const before = frames.sent;
    progress?.("upload", 0, total);
    for await (const bytes of patch.read()) {
      signal?.throwIfAborted();
      await frames.writeBytes(bytes);
      progress?.("upload", frames.sent - before, total);
    }
    signal?.throwIfAborted();
    beforeFinish?.();
    await frames.write(Buffer.alloc(0));
    progress?.("upload", total, total);
    const deltaSeconds = (performance.now() - tick) / 1000;
    const result: unknown = JSON.parse((await frames.read(4096)).toString());
    if (
      typeof result !== "object" ||
      !result ||
      !("sha256" in result) ||
      result.sha256 !== sha256 ||
      !("bytes" in result) ||
      result.bytes !== data.length
    )
      throw Error("InvalidAcknowledgement");
    return {
      seconds: (performance.now() - start) / 1000,
      signature_seconds: signatureSeconds,
      delta_transfer_seconds: deltaSeconds,
      sent_bytes: frames.sent,
      received_bytes: frames.received,
      raw_patch_bytes: rawBytes,
      compressed_patch_bytes: patchBytes,
      patch_frames: patchFrames,
      remote: result,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    patch.close();
    await frames.dispose(failure);
  }
}
