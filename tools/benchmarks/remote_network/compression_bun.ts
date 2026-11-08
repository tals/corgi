//! Exercise Bun's public compression APIs on the same held-out wire messages.
import { readFileSync } from "node:fs";
import * as zlib from "node:zlib";
import * as ffi from "bun:ffi";

const [path, mode, dictionaryPath, milliseconds = "150"] = process.argv.slice(2);
const modes = [
  "bun-sync",
  "node-sync",
  "node-sync-dict",
  "frame",
  "frame-dict",
  "live",
  "live-dict",
  "deflate",
  "huffman",
  "ffi-dict",
];
if (!path || !modes.includes(mode) || !dictionaryPath)
  throw Error("Usage: compression_bun.ts CORPUS MODE DICTIONARY|- [CPU_MS]");
const input = readFileSync(path);
const messages: Buffer[] = [];
let at = 4;
for (let i = 0; i < input.readUInt32LE(0); i++) {
  const length = input.readUInt32LE(at);
  at += 4;
  messages.push(input.subarray(at, at + length));
  at += length;
}
if (at !== input.length || !messages.length) throw Error("InvalidCorpus");
const dictionary = dictionaryPath === "-" ? undefined : readFileSync(dictionaryPath);
const withDictionary = mode.endsWith("-dict");
if (withDictionary && !dictionary) throw Error("MissingDictionary");
const options: zlib.ZstdOptions = {
  params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  ...(withDictionary ? { dictionary } : {}),
};
const synchronous = mode.includes("sync") || mode === "ffi-dict";
const live = mode === "live" || mode === "live-dict";
const deflate = mode === "deflate" || mode === "huffman";
const encodeFlush = deflate
  ? zlib.constants.Z_PARTIAL_FLUSH
  : live
    ? zlib.constants.ZSTD_e_flush
    : zlib.constants.ZSTD_e_end;
const decodeFlush = deflate ? zlib.constants.Z_SYNC_FLUSH : zlib.constants.ZSTD_e_flush;
const cpu = () => {
  const value = process.cpuUsage();
  return value.user + value.system;
};
const setupStart = performance.now();
const library =
  mode === "ffi-dict"
    ? ffi.dlopen("libzstd.so.1", {
        ZSTD_createCCtx: { args: [], returns: "ptr" },
        ZSTD_createDCtx: { args: [], returns: "ptr" },
        ZSTD_createCDict: { args: ["ptr", ffi.FFIType.u64_fast, "i32"], returns: "ptr" },
        ZSTD_createDDict: { args: ["ptr", ffi.FFIType.u64_fast], returns: "ptr" },
        ZSTD_compressBound: { args: [ffi.FFIType.u64_fast], returns: ffi.FFIType.u64_fast },
        ZSTD_compress_usingCDict: {
          args: ["ptr", "ptr", ffi.FFIType.u64_fast, "ptr", ffi.FFIType.u64_fast, "ptr"],
          returns: ffi.FFIType.u64_fast,
        },
        ZSTD_decompress_usingDDict: {
          args: ["ptr", "ptr", ffi.FFIType.u64_fast, "ptr", ffi.FFIType.u64_fast, "ptr"],
          returns: ffi.FFIType.u64_fast,
        },
        ZSTD_isError: { args: [ffi.FFIType.u64_fast], returns: "u32" },
        ZSTD_freeCCtx: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_freeDCtx: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_freeCDict: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_freeDDict: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_sizeof_CCtx: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_sizeof_DCtx: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_sizeof_CDict: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_sizeof_DDict: { args: ["ptr"], returns: ffi.FFIType.u64_fast },
        ZSTD_versionNumber: { args: [], returns: "u32" },
      })
    : null;
const native = library
  ? (() => {
      const s = library.symbols;
      const enc = s.ZSTD_createCCtx(),
        dec = s.ZSTD_createDCtx();
      const cdict = s.ZSTD_createCDict(ffi.ptr(dictionary!), dictionary!.length, 3);
      const ddict = s.ZSTD_createDDict(ffi.ptr(dictionary!), dictionary!.length);
      if (!enc || !dec || !cdict || !ddict) throw Error("NativeInitFailed");
      const largest = Math.max(...messages.map(m => m.length));
      const encoded = Buffer.allocUnsafe(Number(s.ZSTD_compressBound(largest)));
      const decoded = Buffer.allocUnsafe(largest);
      return {
        compress(data: Buffer) {
          const n = s.ZSTD_compress_usingCDict(
            enc,
            ffi.ptr(encoded),
            encoded.length,
            ffi.ptr(data),
            data.length,
            cdict,
          );
          if (s.ZSTD_isError(n)) throw Error("NativeEncodeFailed");
          return Buffer.from(encoded.subarray(0, Number(n)));
        },
        decompress(data: Buffer) {
          const n = s.ZSTD_decompress_usingDDict(
            dec,
            ffi.ptr(decoded),
            decoded.length,
            ffi.ptr(data),
            data.length,
            ddict,
          );
          if (s.ZSTD_isError(n)) throw Error("NativeDecodeFailed");
          return Buffer.from(decoded.subarray(0, Number(n)));
        },
        memory: () => ({
          encoder: Number(s.ZSTD_sizeof_CCtx(enc)),
          decoder: Number(s.ZSTD_sizeof_DCtx(dec)),
          cdict: Number(s.ZSTD_sizeof_CDict(cdict)),
          ddict: Number(s.ZSTD_sizeof_DDict(ddict)),
          scratch_buffers: encoded.length + decoded.length,
        }),
        version: s.ZSTD_versionNumber(),
        close() {
          s.ZSTD_freeCCtx(enc);
          s.ZSTD_freeDCtx(dec);
          s.ZSTD_freeCDict(cdict);
          s.ZSTD_freeDDict(ddict);
        },
      };
    })()
  : null;

type Stream = zlib.ZstdCompress | zlib.ZstdDecompress | zlib.Deflate | zlib.Inflate;
function channel(stream: Stream) {
  let chunks: Buffer[] = [];
  let failure: Error | null = null;
  let reject: ((error: Error) => void) | null = null;
  stream.on("data", chunk => chunks.push(chunk));
  stream.on("error", error => {
    failure = error;
    reject?.(error);
  });
  return {
    exchange(data: Buffer | null, kind: number): Promise<Buffer> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, fail) => {
        reject = fail;
        const complete = (error?: Error | null) => {
          reject = null;
          const issue = error ?? failure;
          if (issue) return fail(issue);
          const output = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          chunks = [];
          resolve(output);
        };
        if (data) stream.write(data, complete);
        else stream.flush(kind, complete);
      });
    },
    reset: () => {
      if (!("reset" in stream)) throw Error("ResetUnsupported");
      stream.reset();
    },
    close: () => stream.destroy(),
  };
}

const encoder = synchronous
  ? null
  : channel(
      deflate
        ? zlib.createDeflate({
            flush: encodeFlush,
            level: mode === "huffman" ? 1 : 6,
            windowBits: 15,
            memLevel: 8,
            strategy: mode === "huffman" ? zlib.constants.Z_HUFFMAN_ONLY : zlib.constants.Z_DEFAULT_STRATEGY,
          })
        : zlib.createZstdCompress({ ...options, flush: encodeFlush }),
    );
const decoder = synchronous
  ? null
  : channel(
      deflate
        ? zlib.createInflate({ flush: decodeFlush })
        : zlib.createZstdDecompress({ flush: decodeFlush, ...(withDictionary ? { dictionary } : {}) }),
    );
const setupMs = performance.now() - setupStart;
const compress = (data: Buffer) =>
  native
    ? native.compress(data)
    : mode === "bun-sync"
      ? Bun.zstdCompressSync(data, { level: 3 })
      : zlib.zstdCompressSync(data, options);
const decompress = (data: Buffer) =>
  native
    ? native.decompress(data)
    : mode === "bun-sync"
      ? Bun.zstdDecompressSync(data)
      : zlib.zstdDecompressSync(data, withDictionary ? { dictionary } : {});
let sink = 0;
const compressedRange = [Infinity, 0];

async function encodePass(collect: boolean) {
  const output: Buffer[] = [];
  let bytes = 0;
  if (deflate) encoder!.reset();
  if (synchronous) {
    for (const message of messages) {
      const compressed = compress(message);
      bytes += compressed.length;
      if (collect) output.push(compressed);
    }
  } else {
    for (const message of messages) {
      const compressed = await encoder!.exchange(message, encodeFlush);
      bytes += compressed.length;
      if (collect) output.push(compressed);
    }
  }
  // End only the zstd frame; the public stream and its dictionary remain alive.
  const trailer = live ? await encoder!.exchange(null, zlib.constants.ZSTD_e_end) : null;
  sink ^= bytes;
  compressedRange[0] = Math.min(compressedRange[0], bytes);
  compressedRange[1] = Math.max(compressedRange[1], bytes);
  return { output, trailer, bytes };
}

async function decodePass(encoded: Buffer[], trailer: Buffer | null, verify: boolean) {
  if (deflate) decoder!.reset();
  for (let i = 0; i < encoded.length; i++) {
    const decoded = synchronous ? decompress(encoded[i]) : await decoder!.exchange(encoded[i], decodeFlush);
    sink ^= decoded.length;
    if (verify && !decoded.equals(messages[i])) throw Error(`RoundtripMismatch: ${i}`);
    if (
      verify &&
      !live &&
      !deflate &&
      !zlib.zstdDecompressSync(encoded[i], withDictionary ? { dictionary } : {}).equals(messages[i])
    )
      throw Error(`IndependentFrameMismatch: ${i}`);
  }
  if (trailer && (await decoder!.exchange(trailer, decodeFlush)).length) throw Error("DelayedOutput");
  if (
    verify &&
    live &&
    !zlib
      .zstdDecompressSync(Buffer.concat([...encoded, trailer!]), withDictionary ? { dictionary } : {})
      .equals(Buffer.concat(messages))
  )
    throw Error("IndependentSessionMismatch");
}

try {
  const first = await encodePass(true);
  await decodePass(first.output, first.trailer, true);
  if (withDictionary) {
    let required = false;
    try {
      zlib.zstdDecompressSync(live ? Buffer.concat([...first.output, first.trailer!]) : first.output[0]);
    } catch {
      required = true;
    }
    if (!required) throw Error("DictionaryIgnored");
  }
  for (let warm = 0; warm < 5; warm++) {
    await encodePass(false);
    await decodePass(first.output, first.trailer, false);
  }
  const measure = async (operation: () => Promise<unknown>) => {
    const beginCpu = cpu();
    const beginWall = performance.now();
    let passes = 0;
    let elapsedCpu: number;
    do {
      await operation();
      passes++;
      elapsedCpu = cpu() - beginCpu;
    } while (elapsedCpu < Number(milliseconds) * 1000);
    return {
      cpu_us_per_message: elapsedCpu / (passes * messages.length),
      wall_us_per_message: ((performance.now() - beginWall) * 1000) / (passes * messages.length),
      passes,
    };
  };
  const encode = await measure(() => encodePass(false));
  const decode = await measure(() => decodePass(first.output, first.trailer, false));
  const last = await encodePass(true);
  await decodePass(last.output, last.trailer, true);
  console.log(
    JSON.stringify({
      mode,
      bun: Bun.version,
      bun_revision: Bun.revision,
      zstd_revision: process.versions.zstd,
      zlib_revision: process.versions.zlib,
      messages: messages.length,
      raw_bytes: messages.reduce((n, b) => n + b.length, 0),
      compressed_bytes: first.bytes,
      warm_compressed_bytes: last.bytes,
      compressed_bytes_range: compressedRange,
      stream_end_bytes: first.trailer?.length ?? 0,
      encode,
      decode,
      setup_ms: setupMs,
      memory: process.memoryUsage(),
      native_memory: native?.memory(),
      native_version: native?.version,
      roundtrip: true,
      independent_frame_verified: !live && !deflate,
      dictionary_required: withDictionary,
      corpus_sha256: new Bun.CryptoHasher("sha256").update(input).digest("hex"),
      dictionary_sha256: withDictionary ? new Bun.CryptoHasher("sha256").update(dictionary!).digest("hex") : null,
      sink,
    }),
  );
} finally {
  encoder?.close();
  decoder?.close();
  native?.close();
  library?.close();
}
