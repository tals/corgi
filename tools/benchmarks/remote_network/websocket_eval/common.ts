import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { dlopen, ptr } from "bun:ffi";

export type Mode = "tcp" | "websocket" | "tcp-zstd" | "websocket-zstd" | "websocket-deflate";
export interface Config {
  mode: Mode;
  corpus: string;
  window: number;
  limit?: number;
  reconnect?: number;
}
const clock = dlopen("libc.so.6", {
  clock_gettime: { args: ["i32", "ptr"], returns: "i32" },
});
const timespec = new BigInt64Array(2);
/** CLOCK_MONOTONIC has one epoch across processes; Bun hrtime does not. */
export const ns = () => {
  if (clock.symbols.clock_gettime(1, ptr(timespec))) throw Error("ClockFailed");
  return timespec[0] * 1_000_000_000n + timespec[1];
};
export const milliseconds = (a: bigint, b: bigint) => Number(b - a) / 1e6;
export const cpu = () => {
  const value = process.cpuUsage();
  return value.user + value.system;
};
export function corpus(name: string, limit?: number): Buffer[] {
  const bytes = gunzipSync(readFileSync(join(import.meta.dir, "fixtures", name + ".jsonl.gz")));
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "manifest.json"), "utf8"));
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== manifest[name].corpus_sha256)
    throw Error("CorpusHashMismatch");
  const lines: Buffer[] = [];
  let at = 0;
  for (;;) {
    const end = bytes.indexOf(10, at);
    if (end < 0) break;
    lines.push(bytes.subarray(at, end + 1));
    at = end + 1;
  }
  if (at !== bytes.length || lines.length !== manifest[name].messages) throw Error("InvalidCorpus");
  return limit ? lines.slice(0, limit) : lines;
}
export function lines(receive: (line: Buffer) => void) {
  let pending = Buffer.alloc(0);
  return (bytes: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      const line = pending.subarray(0, end + 1);
      pending = pending.subarray(end + 1);
      receive(line);
    }
    if (pending.length > 4 * 1024 * 1024) throw Error("LineTooLarge");
  };
}
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
  return { count: values.length, min: at(0), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}
