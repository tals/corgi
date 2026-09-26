import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellJoin } from "./support";

// A child of a test pane owns all listeners, so the discovery assertions can
// distinguish the pane's ports from unrelated listeners on the host.
export function fixture(
  root: string,
  options: {
    cert?: string;
    key?: string;
    status?: boolean;
    single?: boolean;
  } = {},
) {
  const script = join(root, "port-fixture.ts");
  const ready = join(root, "port-ready.json");
  writeFileSync(
    script,
    `import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { createServer as tcp } from 'node:net';
import { createSocket } from 'node:dgram';
import { readFileSync, writeFileSync } from 'node:fs';
const [ready, mode, cert, key] = process.argv.slice(2);
const listen = (server, host) => new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
const handler = (status) => (request, response) => { response.statusCode = status; if (status === 302) response.setHeader('Location', '/login'); response.end(); };
const ports = {};
if (mode === 'single') {
  ports.single = await listen(http(handler(200)), '127.0.0.1');
} else if (mode === 'status') {
  for (const status of [200, 302, 401, 404, 500]) ports[String(status)] = await listen(http(handler(status)), '127.0.0.1');
  ports.raw = await listen(tcp(socket => { socket.write('NOT HTTP\\r\\n'); socket.end(); }), '127.0.0.1');
} else {
  ports.wild = await listen(http(handler(200)), '0.0.0.0');
  ports.local = await listen(http(handler(200)), '127.0.0.1');
  ports.secure = await listen(https({cert: readFileSync(cert), key: readFileSync(key)}, handler(200)), '127.0.0.1');
  const udp = createSocket('udp4');
  ports.udp = await new Promise(resolve => udp.bind(0, '127.0.0.1', () => resolve(udp.address().port)));
}
ports.pid = process.pid;
writeFileSync(ready, JSON.stringify(ports));
setInterval(() => {}, 1000);
`,
  );
  const mode = options.single ? "single" : options.status ? "status" : "full";
  const command = shellJoin([
    "bun",
    script,
    ready,
    mode,
    options.cert ?? "",
    options.key ?? "",
  ]);
  return { command, ready, script };
}
