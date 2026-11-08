import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Channel } from "../../../../src/wire_compression";

const results: unknown[] = [];
async function probe(
  label: string,
  options: {
    unix?: boolean;
    deflate?: any;
    clientDeflate?: boolean;
    zstd?: boolean;
    forceExtension?: string;
    offerExtension?: string;
  },
) {
  const directory = mkdtempSync("/tmp/corgi-ws-capability-"),
    path = directory + "/s";
  let request: Record<string, string> = {},
    serverCodec: Channel | null = null,
    clientCodec: Channel | null = null;
  let incoming = "",
    replies: string[] = [],
    encodedCosts: number[] = [],
    serverMethods: unknown;
  const expected = [
    JSON.stringify({ index: 1, body: "a moderately typical repeated field value ".repeat(400) }),
    JSON.stringify({ index: 2, body: "a moderately typical repeated field value ".repeat(400) }),
  ];
  const server = Bun.serve<any>({
    ...(options.unix ? { unix: path } : { hostname: "127.0.0.1", port: 0 }),
    fetch(req, server) {
      request = Object.fromEntries(req.headers);
      const headers: Record<string, string> = {};
      if (options.zstd) headers["Sec-WebSocket-Protocol"] = "corgi.zstd.v1";
      if (options.forceExtension) headers["Sec-WebSocket-Extensions"] = options.forceExtension;
      if (server.upgrade(req, { headers })) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      perMessageDeflate: options.deflate ?? false,
      idleTimeout: 0,
      open(ws) {
        serverMethods = Object.fromEntries(
          ["pause", "resume", "terminate", "getBufferedAmount"].map(name => [name, typeof (ws as any)[name]]),
        );
        if (options.zstd)
          serverCodec = new Channel(
            bytes => ws.send(bytes, false),
            bytes => serverCodec!.encode(bytes),
            () => ws.terminate(),
          );
      },
      message(ws, message) {
        if (options.zstd) serverCodec!.decode(Buffer.from(message));
        else ws.send(message, true);
      },
    },
  });
  const url = options.unix ? `ws+unix://${path}:/rpc` : `ws://127.0.0.1:${server.port}/rpc`;
  let socket: WebSocket | undefined;
  const result: Record<string, unknown> = { label, url, bun: Bun.version };
  try {
    socket = new WebSocket(url, {
      perMessageDeflate: options.clientDeflate ?? false,
      ...(options.zstd ? { protocols: ["corgi.zstd.v1"] } : {}),
      ...(options.offerExtension ? { headers: { "Sec-WebSocket-Extensions": options.offerExtension } } : {}),
    });
    const current = socket;
    result.clientMethods = Object.fromEntries(
      ["pause", "resume", "terminate", "ping", "pong"].map(name => [name, typeof (current as any)[name]]),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("timeout")), 2000);
      current.onopen = () => {
        result.extensions = current.extensions;
        result.protocol = current.protocol;
        if (options.zstd) {
          clientCodec = new Channel(
            bytes => current.send(bytes),
            bytes => {
              incoming += bytes.toString();
              const lines = incoming.split("\n");
              incoming = lines.pop()!;
              replies.push(...lines);
              if (replies.length === expected.length) {
                clearTimeout(timer);
                resolve();
              }
            },
            error => {
              clearTimeout(timer);
              reject(error);
            },
          );
          for (const value of expected)
            clientCodec.encode(Buffer.from(value + "\n"), count => encodedCosts.push(count));
        } else for (const value of expected) current.send(value);
      };
      current.onmessage = event => {
        if (options.zstd) clientCodec!.decode(Buffer.from(event.data));
        else {
          replies.push(String(event.data));
          if (replies.length === expected.length) {
            clearTimeout(timer);
            resolve();
          }
        }
      };
      current.onerror = event => {
        clearTimeout(timer);
        reject(Error((event as ErrorEvent).message));
      };
      current.onclose = event => {
        result.closeCode = event.code;
        if (replies.length !== expected.length) {
          clearTimeout(timer);
          reject(Error("closed"));
        }
      };
    });
    result.exact = JSON.stringify(replies) === JSON.stringify(expected);
    result.rawBytes = expected.reduce((n, value) => n + Buffer.byteLength(value) + 1, 0);
    result.compressedChunkBytes = encodedCosts;
  } catch (error) {
    result.error = String(error);
  } finally {
    result.requestExtensions = request["sec-websocket-extensions"] ?? null;
    result.requestProtocol = request["sec-websocket-protocol"] ?? null;
    result.serverMethods = serverMethods;
    results.push(result);
    socket?.terminate();
    clientCodec?.close();
    serverCodec?.close();
    server.stop(true);
    rmSync(directory, { force: true, recursive: true });
  }
}

async function backpressure() {
  const result = {
    label: "server-backpressure",
    sent: 0,
    queued: 0,
    dropped: 0,
    maximumBuffered: 0,
    drains: 0,
    received: 0,
  };
  let resume: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("no");
    },
    websocket: {
      idleTimeout: 0,
      backpressureLimit: 65536,
      closeOnBackpressureLimit: false,
      message(ws) {
        const data = Buffer.alloc(16384);
        for (let i = 0; i < 1000; i++) {
          const status = ws.send(data);
          if (status > 0) result.sent++;
          else if (status === -1) result.queued++;
          else result.dropped++;
          result.maximumBuffered = Math.max(result.maximumBuffered, ws.getBufferedAmount());
          if (!status) break;
        }
      },
      drain() {
        result.drains++;
      },
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        socket.pause();
        socket.send("fill");
        resume = setTimeout(() => {
          socket.resume();
          setTimeout(resolve, 100);
        }, 50);
      };
      socket.onerror = () => reject(Error("WebSocketFailed"));
      socket.onmessage = () => result.received++;
    });
  } finally {
    clearTimeout(resume);
    socket.terminate();
    server.stop(true);
    results.push(result);
  }
}

await probe("tcp-identity", {});
await probe("tcp-deflate-shared", { deflate: true, clientDeflate: true });
await probe("tcp-deflate-history", {
  deflate: { compress: "dedicated", decompress: "dedicated" },
  clientDeflate: true,
});
await probe("custom-zstd-offer-header-ignored", { deflate: true, offerExtension: "permessage-zstd" });
await probe("custom-zstd-selection-header-ignored", {
  forceExtension: "permessage-zstd",
  offerExtension: "permessage-zstd",
});
await probe("tcp-zstd-binary-subprotocol", { zstd: true });
await probe("unix-identity", { unix: true });
await probe("unix-zstd-binary-subprotocol", { unix: true, zstd: true });
await backpressure();
writeFileSync(import.meta.dir + "/capabilities.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
