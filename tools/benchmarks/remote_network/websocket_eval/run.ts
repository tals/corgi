import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { type Config, type Mode } from "./common";
import { proxy, type Shape } from "./proxy";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const output = arg("--output", join(import.meta.dir, "results"));
const trials = Number(arg("--trials", "3"));
const quick = args.includes("--quick");
const modes = arg("--modes", "tcp,websocket,tcp-zstd,websocket-zstd,websocket-deflate").split(",") as Mode[];
const corpora = arg("--corpora", quick ? "sparse,dense" : "sparse,dense,claude,codex").split(",");
const cores = arg("--cores", "176,177,178").split(",").map(Number);
const endpoint = join(import.meta.dir, "endpoint.ts");
const cases: {
  name: string;
  shape: Shape;
  window: number;
  reconnect?: number;
  limit?: number;
  modes?: Mode[];
  corpora?: string[];
}[] = [
  { name: "latency", shape: {}, window: 1 },
  { name: "throughput", shape: {}, window: 16 },
  {
    name: "300ms-1mbit",
    shape: { rtt_ms: 300, bytes_per_second: 125000 },
    window: 16,
    limit: 96,
    modes: ["tcp-zstd", "websocket-zstd", "websocket-deflate"],
    corpora: ["sparse", "dense"],
  },
  {
    name: "freeze",
    shape: { rtt_ms: 30, freeze_after_ms: 100, freeze_ms: 1000 },
    window: 16,
    modes: ["tcp-zstd", "websocket-zstd", "websocket-deflate"],
    corpora: ["dense"],
  },
  {
    name: "reconnect",
    shape: { rtt_ms: 30 },
    window: 16,
    reconnect: 48,
    modes: ["tcp-zstd", "websocket-zstd", "websocket-deflate"],
    corpora: ["dense"],
  },
];
const names = arg("--cases", quick ? "latency,throughput" : cases.map(value => value.name).join(",")).split(",");
if (quick && names.some(name => name !== "latency" && name !== "throughput"))
  throw Error("Quick mode supports latency and throughput only");
mkdirSync(output, { recursive: true });
writeFileSync(
  join(output, "environment.json"),
  JSON.stringify(
    {
      bun: Bun.version,
      revision: Bun.revision,
      date: new Date().toISOString(),
      cpus: cpus().map(value => value.model),
      cores,
      args,
      corpus: JSON.parse(readFileSync(join(import.meta.dir, "fixtures/manifest.json"), "utf8")),
      source_sha256: Object.fromEntries(
        ["endpoint.ts", "proxy.ts", "common.ts", "run.ts"].map(file => [
          file,
          new Bun.CryptoHasher("sha256").update(readFileSync(join(import.meta.dir, file))).digest("hex"),
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
function child(role: string, config: Config, core: number, port?: number) {
  const process = Bun.spawn(
    ["taskset", "-c", String(core), Bun.argv[0], endpoint, role, JSON.stringify(config), String(port ?? 0)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const pending: any[] = [],
    waits: ((value: any) => void)[] = [];
  let failure: Error | null = null;
  const reader = (async () => {
    let input = "";
    for await (const data of process.stdout) {
      input += Buffer.from(data).toString();
      for (;;) {
        const end = input.indexOf("\n");
        if (end < 0) break;
        const value = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        const wait = waits.shift();
        if (wait) wait(value);
        else pending.push(value);
      }
    }
    if (await process.exited) {
      failure = Error(await new Response(process.stderr).text());
      for (const wait of waits.splice(0)) wait({ failure: failure.message });
    }
  })();
  return {
    process,
    async next() {
      if (failure) throw failure;
      const value = pending.shift() ?? (await new Promise(resolve => waits.push(resolve)));
      if (value.failure) throw Error(value.failure);
      return value;
    },
    async stop() {
      process.kill();
      await process.exited;
      await reader;
    },
  };
}
const jobs = [];
for (let trial = 0; trial < trials; trial++)
  for (const scenario of cases.filter(value => names.includes(value.name)))
    for (const corpus of corpora.filter(value => !scenario.corpora || scenario.corpora.includes(value)))
      for (const mode of modes.filter(value => !scenario.modes || scenario.modes.includes(value)))
        jobs.push({ trial, scenario, corpus, mode });
// Fixed shuffle limits systematic thermal/order bias without tuning the workload.
let seed = 0x4c6f7267;
for (let i = jobs.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1);
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
const rows: any[] = [];
for (const [index, job] of jobs.entries()) {
  const config: Config = {
    mode: job.mode,
    corpus: job.corpus,
    window: job.scenario.window,
    limit: quick ? 32 : job.scenario.limit,
    reconnect: job.scenario.reconnect,
  };
  const server = child("server", config, cores[0]);
  let client: ReturnType<typeof child> | null = null,
    wire: Awaited<ReturnType<typeof proxy>> | null = null;
  const timeout = setTimeout(() => {
    console.error("TrialTimedOut", job);
    server.process.kill();
    client?.process.kill();
  }, 120000);
  try {
    const ready = await server.next();
    wire = await proxy(ready.port, job.mode.startsWith("websocket"), job.scenario.shape);
    client = child("client", config, cores[1], wire.port);
    const [sent, received] = await Promise.all([server.next(), client.next()]);
    const row = {
      scenario: job.scenario.name,
      shape: job.scenario.shape,
      trial: job.trial,
      config,
      server: sent,
      client: received,
      wire: wire.result(),
    };
    if (sent.delivery_ms.min < 0) throw Error("InvalidCrossProcessClock");
    if (sent.messages !== received.messages || sent.raw_bytes !== received.verified_bytes)
      throw Error("UnverifiedPayloads");
    for (const session of row.wire.sessions) {
      if (job.mode.startsWith("websocket")) {
        const negotiated = session.down.handshake
          .toLowerCase()
          .includes("sec-websocket-extensions: permessage-deflate");
        if (negotiated !== (job.mode === "websocket-deflate")) throw Error("WrongExtensionNegotiated");
        if (session.down.handshake.includes("no_context_takeover")) throw Error("UnexpectedHistoryReset");
        if (job.mode === "websocket-deflate" && session.down.compressed_frames !== session.down.frames)
          throw Error("UncompressedDeflateFrame");
        if (job.mode !== "websocket-deflate" && session.down.compressed_frames) throw Error("DoubleCompression");
        if (session.up.frames !== session.up.masked_frames) throw Error("UnmaskedClientFrame");
      }
      if (!config.reconnect && (session.up.incomplete_bytes || session.down.incomplete_bytes))
        throw Error("IncompleteTransportFrame");
    }
    if (config.reconnect && received.connections !== 2) throw Error("ReconnectNotExercised");
    if (job.scenario.name === "freeze" && !row.wire.freeze_bytes) throw Error("FreezeNotExercised");
    rows.push(row);
    writeFileSync(join(output, "trials.json"), JSON.stringify(rows, null, 2) + "\n");
    console.log(
      `${index + 1}/${jobs.length} ${job.scenario.name} ${job.corpus} ${job.mode}: ${sent.duration_ms.toFixed(1)} ms`,
    );
  } catch (error) {
    console.error(job);
    throw error;
  } finally {
    clearTimeout(timeout);
    await client?.stop();
    await server.stop();
    await wire?.close();
  }
}
