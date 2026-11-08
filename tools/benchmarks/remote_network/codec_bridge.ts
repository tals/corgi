//! Lab-only duplex compression around an unchanged SSH bridge command.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Transform, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

const [side, mode, log, ...command] = process.argv.slice(2);
if (!["client", "server"].includes(side) || !["zstd", "identity"].includes(mode) || !command.length)
  throw Error("Usage: codec_bridge.ts client|server zstd|identity LOG COMMAND...");
const started = Date.now();
const counters: Record<string, number> = {};
function meter(name: string) {
  counters[name] = 0;
  return new Transform({
    transform(data: Buffer, _encoding, callback) {
      counters[name] += data.length;
      callback(null, data);
    },
  });
}
const encoder =
  mode === "zstd"
    ? zlib.createZstdCompress({
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
        flush: zlib.constants.ZSTD_e_flush,
      })
    : new PassThrough();
const decoder = mode === "zstd" ? zlib.createZstdDecompress({ flush: zlib.constants.ZSTD_e_flush }) : new PassThrough();
const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  child.kill("SIGTERM");
  process.stdin.destroy();
  child.stdin.destroy();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const exited = new Promise<number>(resolve => {
  child.on("error", () => {
    stop();
    resolve(1);
  });
  child.on("exit", code => {
    process.stdin.destroy();
    resolve(code ?? 1);
  });
});
const incoming =
  side === "client"
    ? pipeline(process.stdin, meter("plain_in"), encoder, meter("compressed_out"), child.stdin)
    : pipeline(process.stdin, meter("compressed_in"), decoder, meter("plain_out"), child.stdin);
const outgoing =
  side === "client"
    ? pipeline(child.stdout, meter("compressed_in"), decoder, meter("plain_out"), process.stdout)
    : pipeline(child.stdout, meter("plain_in"), encoder, meter("compressed_out"), process.stdout);
const results = await Promise.allSettled([
  incoming.catch(error => {
    stop();
    throw error;
  }),
  outgoing.catch(error => {
    stop();
    throw error;
  }),
]);
const code = await exited;
appendFileSync(
  log,
  JSON.stringify({
    side,
    mode,
    pid: process.pid,
    child: child.pid,
    started,
    ended: Date.now(),
    code,
    counters,
    failures: results.flatMap(result => (result.status === "rejected" ? [String(result.reason)] : [])),
  }) + "\n",
);
process.exit(code);
