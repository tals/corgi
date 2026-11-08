/** Verify the units returned by Bun's native compressed send against actual WS frames. */
import { createConnection, createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { Inspect } from "./inspect";

const payload = Buffer.alloc(100_000, 97),
  wire = new Inspect();
let returned: number | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response("Upgrade required", { status: 400 });
  },
  websocket: {
    perMessageDeflate: { compress: "dedicated", decompress: "dedicated" },
    open(ws) {
      returned = ws.send(payload, true);
    },
    message() {},
  },
});
const proxy = createServer(client => {
  const upstream = createConnection({ host: "127.0.0.1", port: server.port! });
  upstream.on("data", bytes => wire.read(bytes));
  client.pipe(upstream).pipe(client);
  client.on("close", () => upstream.destroy());
});
await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
if (!address || typeof address === "string") throw Error("MissingAddress");
const client = new WebSocket(`ws://127.0.0.1:${address.port}/`, { perMessageDeflate: true });
try {
  const received = await new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("ProbeTimeout")), 3000);
    client.onmessage = event => {
      clearTimeout(timeout);
      resolve(Buffer.from(event.data));
    };
    client.onerror = () => reject(Error("ProbeFailed"));
  });
  const observed = wire.result();
  if (!received.equals(payload) || returned !== payload.length || observed.payload >= payload.length)
    throw Error("UnexpectedSendAccounting");
  writeFileSync(
    process.argv[2],
    JSON.stringify(
      {
        bun: Bun.version,
        revision: Bun.revision,
        rawBytes: payload.length,
        returned,
        decodedExact: true,
        wire: observed,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  client.terminate();
  await server.stop(true);
  await new Promise<void>(resolve => proxy.close(() => resolve()));
}
