// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2019 Dropbox, Inc.
// Copyright (c) 2016 bacher09, Artyom Pavlov (RustCrypto/hashes/MD4).
// Ported and modified for Bun by Corgi contributors, 2026-11-16.
// Based on fast_rsync 0.2.0: crc.rs, signature.rs, hashmap_variant.rs,
// diff.rs, consts.rs and patch.rs. See fast_rsync.LICENSE.
// Changes: Bun's MD4, JS maps, chunked delta output and incremental decoding,
// explicit input limits, and safe checks for 64-bit wire integers.
// Upstream archive SHA-256: 3d97c4d6e20491c84c60612a24660fc1fbfc56bfe24f5b49e6a9fd3259010794

export const signatureMagic = 0x72730136;
export const deltaMagic = 0x72730236;
const maximum = 512 * 1024 * 1024;
const chunkSize = 64 * 1024;

function blockSize(block: number): void {
  if (!Number.isInteger(block) || block < 1 || block > 1024 * 1024) throw Error("InvalidBlockSize");
}
function weak(data: Buffer): number {
  let a = 0,
    b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i] + 31;
    b += a;
  }
  return (((b & 65535) << 16) | (a & 65535)) >>> 0;
}
function rotate(sum: number, size: number, old: number, newer: number): number {
  const a = ((sum & 65535) + newer - old) & 65535;
  const b = ((sum >>> 16) + a - size * (old + 31)) & 65535;
  return ((b << 16) | a) >>> 0;
}

export function signature(old: Buffer, block: number, strong = 16): Buffer {
  blockSize(block);
  if (!Number.isInteger(strong) || strong < 0 || strong > 16 || old.length > maximum)
    throw Error("InvalidSignatureOptions");
  const size = 12 + Math.ceil(old.length / block) * (4 + strong);
  if (size > maximum) throw Error("SignatureTooLarge");
  const result = Buffer.allocUnsafe(size);
  result.writeUInt32BE(signatureMagic, 0);
  result.writeUInt32BE(block, 4);
  result.writeUInt32BE(strong, 8);
  let p = 12;
  for (let i = 0; i < old.length; i += block) {
    const bytes = old.subarray(i, i + block);
    result.writeUInt32BE(weak(bytes), p);
    const digest = new Bun.CryptoHasher("md4").update(bytes).digest();
    result.set(digest.subarray(0, strong), p + 4);
    p += 4 + strong;
  }
  return result;
}

type Entry = { strong: string; index: number } | Map<string, number>;
function indexSignature(sig: Buffer): { block: number; strong: number; blocks: Map<number, Entry> } {
  if (sig.length < 12 || sig.readUInt32BE(0) !== signatureMagic) throw Error("InvalidSignature");
  const block = sig.readUInt32BE(4),
    strong = sig.readUInt32BE(8);
  blockSize(block);
  if (strong > 16 || (sig.length - 12) % (4 + strong) || sig.length > maximum) throw Error("InvalidSignature");
  const blocks = new Map<number, Entry>();
  for (let p = 12, i = 0; p < sig.length; p += 4 + strong, i++) {
    const sum = sig.readUInt32BE(p),
      hash = sig.toString("hex", p + 4, p + 4 + strong);
    const entry = blocks.get(sum);
    if (!entry) blocks.set(sum, { strong: hash, index: i });
    else if (entry instanceof Map) entry.set(hash, i);
    else {
      // Preserve upstream's Single -> TwoOrMore insertion order, even for duplicates.
      blocks.set(
        sum,
        new Map([
          [hash, i],
          [entry.strong, entry.index],
        ]),
      );
    }
  }
  return { block, strong, blocks };
}
function sizeClass(value: number): number {
  return value <= 0xff ? 0 : value <= 0xffff ? 1 : value <= 0xffffffff ? 2 : 3;
}
function writeInteger(out: Buffer, value: number, p: number, size: number): void {
  if (size === 8) out.writeBigUInt64BE(BigInt(value), p);
  else out.writeUIntBE(value, p, size);
}
function literalCommand(length: number): Buffer {
  if (length <= 64) return Buffer.from([length]);
  const kind = sizeClass(length),
    size = 1 << kind;
  const result = Buffer.allocUnsafe(1 + size);
  result[0] = 0x41 + kind;
  writeInteger(result, length, 1, size);
  return result;
}
function copyCommand(offset: number, length: number): Buffer {
  const offsetClass = sizeClass(offset),
    lengthClass = sizeClass(length);
  const a = 1 << offsetClass,
    b = 1 << lengthClass;
  const result = Buffer.allocUnsafe(1 + a + b);
  result[0] = 0x45 + offsetClass * 4 + lengthClass;
  writeInteger(result, offset, 1, a);
  writeInteger(result, length, 1 + a, b);
  return result;
}

/** Inputs may be mmap views. Output views borrow input bytes; retain them until consumed. */
export function* deltaChunks(sig: Buffer, data: Buffer): Generator<Buffer> {
  if (data.length > maximum) throw Error("InputTooLarge");
  const { block, strong, blocks } = indexSignature(sig);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(deltaMagic);
  yield header;
  let emitted = 0,
    here = 0;
  let queued: { offset: number; length: number } | null = null;
  function* emit(until: number): Generator<Buffer> {
    if (emitted === until) return;
    if (queued) {
      yield copyCommand(queued.offset, queued.length);
      emitted += queued.length;
      queued = null;
    }
    if (emitted < until) {
      yield literalCommand(until - emitted);
      for (let p = emitted; p < until; p += chunkSize) yield data.subarray(p, Math.min(p + chunkSize, until));
      emitted = until;
    }
  }
  const collisions = new Map<number, number>();
  while (data.length - here >= block) {
    let crc = weak(data.subarray(here, here + block));
    for (;;) {
      if ((collisions.get(crc) ?? 0) < 1024) {
        const entry = blocks.get(crc);
        if (entry) {
          const hash = new Bun.CryptoHasher("md4")
            .update(data.subarray(here, here + block))
            .digest("hex")
            .slice(0, strong * 2);
          const index = entry instanceof Map ? entry.get(hash) : entry.strong === hash ? entry.index : undefined;
          if (index !== undefined) {
            const offset = index * block;
            if (queued && emitted + queued.length === here && queued.offset + queued.length === offset)
              queued.length += block;
            else {
              yield* emit(here);
              queued = { offset, length: block };
            }
            here += block;
            break;
          }
          collisions.set(crc, (collisions.get(crc) ?? 0) + 1);
        }
      }
      here++;
      if (here + block > data.length) break;
      crc = rotate(crc, block, data[here - 1], data[here + block - 1]);
    }
  }
  yield* emit(data.length);
  yield Buffer.from([0]);
}

export function delta(sig: Buffer, data: Buffer): Buffer {
  return Buffer.concat([...deltaChunks(sig, data)]);
}

type State = "magic" | "command" | "literal_length" | "copy" | "literal" | "end";

/** Incremental decoder. Fully consume each write() generator before supplying more bytes. */
export class Decoder {
  private state: State = "magic";
  private header = Buffer.allocUnsafe(16);
  private have = 0;
  private need = 4;
  private offsetSize = 0;
  private remaining = 0;
  private written = 0;
  constructor(
    private basis: Buffer,
    private limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum) throw Error("InvalidOutputLimit");
  }
  private integer(p: number, size: number): number {
    if (size !== 8) return this.header.readUIntBE(p, size);
    const value = this.header.readBigUInt64BE(p);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("IntegerOverflow");
    return Number(value);
  }
  private reserve(size: number): void {
    if (size > this.limit - this.written) throw Error("OutputLimit");
    this.written += size;
  }
  private literal(size: number): void {
    this.reserve(size);
    this.remaining = size;
    this.state = size ? "literal" : "command";
    this.need = 1;
  }
  *write(input: Buffer): Generator<Buffer> {
    let p = 0;
    while (p < input.length) {
      if (this.state === "end") throw Error("TrailingData");
      if (this.state === "literal") {
        const n = Math.min(this.remaining, input.length - p, chunkSize);
        const output = input.subarray(p, p + n);
        p += n;
        this.remaining -= n;
        if (!this.remaining) this.state = "command";
        yield output;
        continue;
      }
      const n = Math.min(this.need - this.have, input.length - p);
      input.copy(this.header, this.have, p, p + n);
      p += n;
      this.have += n;
      if (this.have < this.need) continue;
      this.have = 0;
      switch (this.state) {
        case "magic":
          if (this.header.readUInt32BE() !== deltaMagic) throw Error("WrongMagic");
          this.state = "command";
          this.need = 1;
          break;
        case "command": {
          const op = this.header[0];
          if (op === 0) this.state = "end";
          else if (op <= 0x40) this.literal(op);
          else if (op <= 0x44) {
            this.state = "literal_length";
            this.need = 1 << (op - 0x41);
          } else if (op <= 0x54) {
            const kind = op - 0x45;
            this.state = "copy";
            this.offsetSize = 1 << (kind >> 2);
            this.need = this.offsetSize + (1 << (kind & 3));
          } else throw Error("UnknownCommand");
          break;
        }
        case "literal_length":
          this.literal(this.integer(0, this.need));
          break;
        case "copy": {
          const offset = this.integer(0, this.offsetSize),
            length = this.integer(this.offsetSize, this.need - this.offsetSize);
          if (!length) throw Error("CopyZero");
          if (offset > this.basis.length || length > this.basis.length - offset) throw Error("CopyOutOfBounds");
          this.reserve(length);
          this.state = "command";
          this.need = 1;
          for (let start = offset; start < offset + length; start += chunkSize)
            yield this.basis.subarray(start, Math.min(start + chunkSize, offset + length));
          break;
        }
      }
    }
  }
  finish(): number {
    if (this.state !== "end") throw Error("UnexpectedEOF");
    return this.written;
  }
}

export function apply(old: Buffer, patch: Buffer, limit: number): Buffer {
  const decoder = new Decoder(old, limit),
    out = Buffer.allocUnsafe(limit);
  let written = 0;
  for (const bytes of decoder.write(patch)) {
    bytes.copy(out, written);
    written += bytes.length;
  }
  decoder.finish();
  return out.subarray(0, written);
}
