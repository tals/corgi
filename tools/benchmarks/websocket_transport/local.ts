import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as os from "node:os";
import * as net from "node:net";
import * as rpc from "../../../src/rpc";
import * as peer from "../../../src/peer";
import * as json from "../../../src/json";
import { n, ptr, ReadyLoop, READ } from "../../../src/native_bridge";

const argument = (name: string, fallback: string) => {
  const at = Bun.argv.indexOf(name);
  return at < 0 ? fallback : Bun.argv[at + 1];
};
const role = argument("--role", "run"),
  socket = argument("--socket", ""),
  corpus = argument("--corpus", "dense"),
  transport = argument("--transport", "websocket") as "stream" | "websocket",
  scenario = argument("--scenario", "paced");
const cpu = () => {
  const value = process.cpuUsage();
  return value.user + value.system;
};
const fixtureRoot = path.join(import.meta.dir, "../remote_network/websocket_eval/fixtures");
function frames() {
  const bytes = zlib.gunzipSync(fs.readFileSync(path.join(fixtureRoot, corpus + ".jsonl.gz"))),
    manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"));
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== manifest[corpus].corpus_sha256)
    throw Error("CorpusHashMismatch");
  return bytes
    .toString()
    .trim()
    .split("\n")
    .map(line => json.parse(line));
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
  };
}
if (role === "server") {
  const source = frames(),
    loop = new ReadyLoop(),
    clients = new Set<peer.Client>();
  let started = cpu(),
    count = 0;
  const listener = n.probe_listen(ptr(Buffer.from(socket + "\0")));
  if (listener < 0) throw Error("ListenFailed");
  const registration = loop.watch(listener, () => {
    for (;;) {
      const fd = n.probe_accept(listener);
      if (fd < 0) break;
      const client = new peer.Client(
        fd,
        loop,
        cl => {
          const q = cl.take();
          switch (q.op) {
            case "bench.fill":
              cl.queue({ request_id: q.request_id, ok: true, padding: "x".repeat(2 * 1024 * 1024) });
              break;
            case "bench.start":
              started = cpu();
              count = 0;
              cl.queue({ request_id: q.request_id, ok: true });
              break;
            case "bench.next":
              count++;
              cl.queue({ ...source[q.index], request_id: q.request_id });
              break;
            case "bench.stop":
              cl.queue({ request_id: q.request_id, ok: true, cpu_us: cpu() - started, count });
              break;
            default:
              cl.queue({ request_id: q.request_id, ok: true, pid: process.pid });
          }
          cl.done();
        },
        () => clients.delete(client),
      );
      clients.add(client);
    }
    registration.arm(READ);
  });
  registration.arm(READ);
  process.on("SIGTERM", () => {
    for (const client of clients) client.close();
    registration.close();
    n.probe_close(listener);
    loop.close();
    process.exit(0);
  });
  console.log("ready");
} else if (role === "client") {
  if (scenario === "isolation") {
    const results: { connections: number; ping_ms: number }[] = [];
    for (const connections of [1, 2]) {
      const data = new rpc.Connection(socket, { timeout_ms: 3000 }),
        control = connections === 1 ? data : new rpc.Connection(socket, { timeout_ms: 3000 });
      let restore: ReturnType<typeof setTimeout> | undefined;
      try {
        await data.call("ping");
        await control.call("ping");
        // Stop the native reader, so the 2 MiB reply backs up in the socket too.
        const native = Reflect.get(data.socket, "ws") as Bun.WebSocket;
        data.socket.pause();
        native.pause();
        const fill = data.rawRequest({ op: "bench.fill" });
        restore = setTimeout(() => {
          native.resume();
          data.socket.resume();
        }, 250);
        const at = performance.now();
        await control.call("ping");
        results.push({ connections, ping_ms: performance.now() - at });
        const reply = json.object(await fill);
        if (reply.padding !== "x".repeat(2 * 1024 * 1024)) throw Error("PayloadMismatch");
      } finally {
        clearTimeout(restore);
        data.close();
        control.close();
      }
    }
    console.log(JSON.stringify({ transport, corpus, scenario, hold_ms: 250, results, validated: true }));
    process.exit(0);
  }
  const source = frames(),
    opens: number[] = [];
  for (let i = 0; i < 31; i++) {
    const start = performance.now(),
      conn = new rpc.Connection(transport === "stream" ? net.createConnection(socket) : socket, { timeout_ms: 3000 });
    try {
      await conn.call("ping");
      if (i) opens.push(performance.now() - start);
    } finally {
      conn.close();
    }
  }
  const conn = new rpc.Connection(transport === "stream" ? net.createConnection(socket) : socket, { timeout_ms: 3000 });
  try {
    for (let i = 0; i < 100; i++) await conn.rawRequest({ op: "bench.next", index: i % source.length });
    await conn.rawRequest({ op: "bench.start" });
    const total = scenario === "paced" ? source.length : source.length * 10,
      responses: unknown[] = new Array(total),
      latencies: number[] = [],
      startCpu = cpu(),
      start = performance.now();
    const request = async (i: number) => {
      const at = performance.now();
      responses[i] = await conn.rawRequest({ op: "bench.next", index: i % source.length });
      latencies.push(performance.now() - at);
    };
    if (scenario === "paced") {
      for (let i = 0; i < total; i++) {
        const wait = start + (i * 1000) / 60 - performance.now();
        if (wait > 0) await Bun.sleep(wait);
        await request(i);
      }
    } else {
      for (let i = 0; i < total; i += 16)
        await Promise.all(Array.from({ length: Math.min(16, total - i) }, (_, j) => request(i + j)));
    }
    const elapsed_ms = performance.now() - start,
      client_cpu_us = cpu() - startCpu,
      server = json.object(await conn.rawRequest({ op: "bench.stop" }));
    for (let i = 0; i < total; i++)
      if (json.stringify(responses[i]) !== json.stringify(source[i % source.length])) throw Error("PayloadMismatch");
    if (server.count !== total) throw Error("CountMismatch");
    console.log(
      JSON.stringify({
        transport,
        corpus,
        scenario,
        messages: total,
        elapsed_ms,
        messages_per_second: (total * 1000) / elapsed_ms,
        startup_ms: distribution(opens),
        latency_ms: distribution(latencies),
        client_cpu_us,
        server_cpu_us: server.cpu_us,
        combined_cpu_us_per_message: (client_cpu_us + server.cpu_us) / total,
        validated: true,
      }),
    );
  } finally {
    conn.close();
  }
} else {
  const cores = argument("--cores", "176,177").split(","),
    trials = Number(argument("--trials", "5")),
    out = argument("--out", "dist/local-websocket.json"),
    results: unknown[] = [],
    directory = fs.mkdtempSync("/tmp/corgi-local-ws-bench-");
  try {
    for (let trial = 0; trial < trials; trial++)
      for (const workload of scenario === "isolation" ? ["dense"] : ["sparse", "dense"])
        for (const selected of scenario === "isolation" ? ["isolation"] : ["paced", "saturated"])
          for (const transport of selected === "isolation"
            ? ["websocket"]
            : trial % 2
              ? ["websocket", "stream"]
              : ["stream", "websocket"]) {
            const common = [
                "--socket",
                directory + "/s",
                "--corpus",
                workload,
                "--scenario",
                selected,
                "--transport",
                transport,
              ],
              spawn = (role: string, core: string) =>
                Bun.spawn(["taskset", "-c", core, process.execPath, import.meta.path, "--role", role, ...common], {
                  stdout: "pipe",
                  stderr: "inherit",
                }),
              server = spawn("server", cores[0]);
            try {
              const reader = server.stdout.getReader();
              const ready = await reader.read();
              if (new TextDecoder().decode(ready.value).trim() !== "ready") throw Error("ServerNotReady");
              reader.releaseLock();
              const client = spawn("client", cores[1]);
              const output = await new Response(client.stdout).text();
              if (await client.exited) throw Error("ClientFailed");
              const result = JSON.parse(output);
              results.push({ trial, ...result });
              console.error(
                `${trial + 1}/${trials} ${workload} ${selected} ${transport}: ${result.combined_cpu_us_per_message?.toFixed(1) ?? "verified"}`,
              );
            } finally {
              server.kill();
              await server.exited;
              fs.rmSync(directory + "/s", { force: true });
            }
          }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        { bun: Bun.version, platform: process.platform, cpu: os.cpus()[0].model, cores, trials, results },
        null,
        2,
      ) + "\n",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
