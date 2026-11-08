/** Real daemon, WS bytes counted outside RPC; selective reader stalls need no app hooks. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { Session } from "../../ui_driver";
import { Connection } from "../../../src/rpc";
import { quote } from "../../../tests/support";
import * as surface from "../../../src/pane/surface";
import * as lock from "../cpu_lock";

const option = (key: string, fallback: string) => {
  const i = Bun.argv.indexOf("--" + key);
  return i < 0 ? fallback : Bun.argv[i + 1];
};
const before = path.resolve(option("before", "dist/corgi-control-before")),
  after = path.resolve(option("after", "dist/corgi")),
  output = path.resolve(option("out", "dist/control-priority")),
  repeats = Number(option("repeats", "3")),
  seconds = Number(option("seconds", "6"));
if (fs.existsSync(output)) throw Error("UseFreshOutputDirectory");
fs.mkdirSync(output, { recursive: true });
const release = await lock.acquire();
const rows: unknown[] = [];
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
  };
};
async function measure(binary: string, kind: string, compression: boolean) {
  const session = new Session(binary),
    clients = new Set<net.Socket>();
  let control: Connection | null = null,
    data: Connection | null = null,
    bytes = 0,
    frames = 0,
    serial = 0n;
  const proxy = net.createServer(client => {
    const upstream = net.createConnection(session.env.CORGI_SOCKET!);
    clients.add(client);
    clients.add(upstream);
    upstream.on("data", chunk => (bytes += chunk.length));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  try {
    await session.seed(`${quote(binary)} start`);
    const producer = path.join(session.home, "producer.ts");
    fs.writeFileSync(
      producer,
      `let sequence=0; let seed=42;
function random() { seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return 33+((seed>>>0)%90); }
setInterval(()=>{const tag=String(++sequence).padStart(8,'0');let text='\\x1b[HBEGIN'+tag;
if(${JSON.stringify(kind)}==='dense')for(let row=1;row<47;row++){text+='\\x1b['+(row+1)+';1H';for(let col=0;col<159;col++)text+=String.fromCharCode(random());}
process.stdout.write(text+'\\x1b[48;1HEND'+tag);},20);`,
    );
    const admin = new Connection(session.env.CORGI_SOCKET!, { timeout_ms: 10000 });
    let pane: number;
    try {
      const result = await admin.call("session.command", {
        command: { "pane.create": { workspace: 1, command: `${quote(process.execPath)} ${quote(producer)}` } },
      });
      pane = result.result.pane!;
    } finally {
      admin.close();
    }
    const socket = path.join(session.home, "observed.sock");
    await new Promise<void>(resolve => proxy.listen(socket, resolve));
    control = new Connection(socket, { compression, timeout_ms: 10000 });
    const hello = await control.call("hello"),
      split = hello.capabilities.includes("viewer.stream.configure"),
      { link } = await control.call("link.open");
    await control.call("viewer.open", { cwd: session.cwd, pid: process.pid });
    data = split ? new Connection(socket, { compression, timeout_ms: 10000 }) : control;
    if (split) {
      await data.call("hello");
      await data.call("viewer.data", { link });
    }
    let failure: unknown = null;
    const retained = new Map<number, surface.View>();
    let last = "";
    data.onEvent(event => {
      if (event.type !== "viewer.frame" && event.type !== "viewer.stream") return;
      for (const value of event.view.surfaces) retained.set(value.surface.pane, surface.view(value));
      for (const patch of event.view.patches ?? [])
        retained.set(patch.surface.pane, surface.apply(retained.get(patch.surface.pane), patch));
      const lines = retained.get(pane)?.surface.lines;
      const first = /BEGIN(\d{8})/.exec(lines?.[0] ?? "")?.[1];
      const end = /END(\d{8})/.exec(lines?.at(-1) ?? "")?.[1];
      if (first && first === end && first !== last) {
        last = first;
        frames++;
      }
      if (event.frame !== undefined) {
        if (BigInt(event.frame) !== serial + 1n) failure = Error("FrameSequenceGap");
        serial = BigInt(event.frame);
        void control!
          .call("viewer.receipt", { sequence: event.sequence, frame: serial })
          .catch(error => (failure = error));
      }
    });
    await control.call(split ? "viewer.stream.configure" : "viewer.stream", {
      sequence: 1,
      incremental: true,
      interests: [{ pane, cols: 160, rows: 48 }],
      workspace: 1,
      focus: pane,
    });
    await Bun.sleep(1500);
    const start = performance.now(),
      startBytes = bytes,
      startFrames = frames;
    const latencies: number[] = [];
    while (performance.now() - start < seconds * 1000) {
      const at = performance.now();
      await control.call("ping");
      latencies.push(performance.now() - at);
      await Bun.sleep(Math.max(0, 50 - (performance.now() - at)));
    }
    const elapsed = (performance.now() - start) / 1000;
    const steady = {
      elapsed,
      control_ms: distribution(latencies),
      samples: latencies,
      updates_s: (frames - startFrames) / elapsed,
      downstream_bytes_s: (bytes - startBytes) / elapsed,
    };
    const paused: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ws = Reflect.get(data.socket, "ws") as Bun.WebSocket;
      ws.pause();
      data.socket.pause();
      const resume = setTimeout(() => {
        ws.resume();
        data!.socket.resume();
      }, 250);
      try {
        const at = performance.now();
        await control.call("ping");
        paused.push(performance.now() - at);
        // Keep the same pause duration in both variants, including quick replies.
        await Bun.sleep(Math.max(0, 275 - (performance.now() - at)));
      } finally {
        clearTimeout(resume);
        ws.resume();
        data.socket.resume();
      }
      await Bun.sleep(100);
    }
    if (failure) throw failure;
    return {
      kind,
      compression,
      split,
      steady,
      paused_ms: distribution(paused),
      paused_samples: paused,
      last_frame: String(serial),
    };
  } finally {
    control?.close();
    data?.close();
    for (const client of clients) client.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await session.close();
  }
}
try {
  fs.writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        bun: Bun.version,
        repeats,
        seconds,
        binaries: [before, after].map(binary => ({
          path: binary,
          sha256: new Bun.CryptoHasher("sha256").update(fs.readFileSync(binary)).digest("hex"),
        })),
        measurement:
          "Real daemon and pane producer, 160x48 at 50 Hz; plain/zstd WS over Unix sockets. Bytes include WS framing. Zstd isolates codec behavior; it is not an SSH/WAN result. Eight selective 250 ms pane-reader pauses per trial.",
      },
      null,
      2,
    ),
  );
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const kind of ["sparse", "dense"])
      for (const compression of [false, true])
        for (const [label, binary] of repeat % 2
          ? [
              ["after", after],
              ["before", before],
            ]
          : [
              ["before", before],
              ["after", after],
            ]) {
          const row = { label, repeat, ...(await measure(binary, kind, compression)) };
          rows.push(row);
          fs.writeFileSync(path.join(output, "trials.json"), JSON.stringify(rows, null, 2));
          console.log(
            JSON.stringify({
              label,
              repeat,
              kind,
              compression,
              ping: row.steady.control_ms,
              paused: row.paused_ms,
              fps: row.steady.updates_s,
            }),
          );
        }
} finally {
  release();
}
