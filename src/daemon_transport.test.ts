import { test, expect } from "bun:test";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { nativeRoot } from "./native_paths";
import * as transport from "./daemon_transport";
import * as lab from "./remote_lab";
import { until } from "./fixtures/until";

const marker = Buffer.from("\ncorgi-bridge-v1\n");

/** The native bridge, run with piped stdio, to `server` listening on a fresh socket. */
async function bridge(server: Server) {
  const dir = mkdtempSync("/tmp/corgi-bridge-test-");
  await new Promise<void>(resolve => server.listen(dir + "/s", resolve));
  const child = Bun.spawn([nativeRoot + "/bin/corgi-remote-bridge", dir + "/s"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    close() {
      child.kill();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("bridge framing discards fragmented banners and preserves binary bytes", async () => {
  const stream = transport.bridgePreamble();
  const chunks: Buffer[] = [];
  stream.on("data", chunk => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => stream.on("end", resolve).on("error", reject));
  for (const byte of Buffer.concat([Buffer.from("login banner\n"), marker, Buffer.from([0, 255, 1, 10])]))
    stream.write(Buffer.from([byte]));
  stream.end();
  await done;
  expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1, 10]));
});

test("bridge framing rejects unbounded banners and early EOF", async () => {
  for (const bytes of [
    Buffer.alloc(65537, 65),
    Buffer.concat([Buffer.alloc(65537, 65), marker]),
    Buffer.from("banner only"),
  ]) {
    const stream = transport.bridgePreamble();
    const error = new Promise<Error>(resolve => stream.on("error", resolve));
    stream.resume();
    stream.end(bytes);
    expect(await error).toBeInstanceOf(Error);
  }
});

test("native bridge carries binary data and drains replies after stdin EOF", async () => {
  const input = Buffer.alloc(512 * 1024);
  for (let i = 0; i < input.length; i++) input[i] = i % 256;
  const received: Buffer[] = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on("data", chunk => received.push(Buffer.from(chunk)));
    socket.on("end", () => socket.end(Buffer.concat([Buffer.concat(received), Buffer.from("tail")])));
  });
  const { child, close } = await bridge(server);
  try {
    const output = new Response(child.stdout).arrayBuffer();
    child.stdin.write(input);
    await child.stdin.end();
    expect(Buffer.from(await output)).toEqual(Buffer.concat([marker, input, Buffer.from("tail")]));
    expect(await child.exited).toBe(0);
  } finally {
    close();
  }
});

test("native bridge accepts input while stdout is backpressured", async () => {
  let peer: Socket | undefined;
  let received = "";
  const server = createServer(socket => {
    peer = socket;
    socket.on("error", () => {});
    socket.on("data", bytes => {
      received += bytes.toString();
    });
    socket.write(Buffer.alloc(8 * 1024 * 1024, 65));
  });
  const { child, close } = await bridge(server);
  try {
    await Bun.sleep(100);
    child.stdin.write("INPUT_WHILE_OUTPUT_BLOCKED");
    await child.stdin.flush();
    await until(() => received !== "", 2000);
    expect(received).toBe("INPUT_WHILE_OUTPUT_BLOCKED");
    child.kill();
    await child.exited;
  } finally {
    peer?.destroy();
    close();
  }
});

test("a machine's connections pass through its faults only while they're on", async () => {
  const dir = mkdtempSync("/tmp/corgi-fake-ssh-"),
    path = process.env.PATH;
  // An ssh that answers as the bridge, then echoes.
  await Bun.write(dir + "/ssh", "#!/bin/sh\nprintf '\\ncorgi-bridge-v1\\n'\nexec cat\n");
  chmodSync(dir + "/ssh", 0o755);
  process.env.PATH = `${dir}:${path}`;
  const profile = {
    name: "lagged",
    target: "lagged",
    executable: "corgi",
    socket: "/tmp/x",
    home: "/tmp",
    bridge: "b",
  };
  const roundTrip = async () => {
    const remote = new transport.Remote(profile);
    await remote.open();
    const client = createConnection(remote.socket);
    const echo = async (text: string) => {
      client.write(text);
      await new Promise<void>(resolve => client.once("data", () => resolve()));
    };
    try {
      // The first exchange also waits for ssh to start.
      await echo("warm");
      const started = performance.now();
      await echo("ping");
      return performance.now() - started;
    } finally {
      client.destroy();
      remote.close();
    }
  };
  try {
    expect(await roundTrip()).toBeLessThan(150);
    lab.local.enable("lagged", true);
    lab.local.apply({ machine: "lagged", latency_ms: 150 });
    expect(await roundTrip()).toBeGreaterThanOrEqual(300);
  } finally {
    lab.local.enable("lagged", false);
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held reply still arrives when ssh exits behind it", async () => {
  const dir = mkdtempSync("/tmp/corgi-fake-ssh-"),
    path = process.env.PATH;
  // An ssh that answers as the bridge, replies once, and exits.
  await Bun.write(dir + "/ssh", "#!/bin/sh\nprintf '\\ncorgi-bridge-v1\\n'\nread line\nprintf 'bye'\n");
  chmodSync(dir + "/ssh", 0o755);
  process.env.PATH = `${dir}:${path}`;
  const remote = new transport.Remote({
    name: "closing",
    target: "closing",
    executable: "corgi",
    socket: "/tmp/x",
    home: "/tmp",
    bridge: "b",
  });
  lab.local.enable("closing", true);
  lab.local.apply({ machine: "closing", latency_ms: 100 });
  try {
    await remote.open();
    const client = createConnection(remote.socket);
    let received = "";
    client.on("data", chunk => (received += chunk));
    const ended = new Promise<void>(resolve => client.once("end", () => resolve()));
    client.write("x\n");
    await ended;
    expect(received).toBe("bye");
    client.destroy();
  } finally {
    remote.close();
    lab.local.enable("closing", false);
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forwarded connection's failure says whether the port, the machine's SSH server, or the machine refused it", () => {
  expect(
    transport.portFailure("channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed"),
  ).toBe("refused");
  // Through a shared master, the reason doesn't come back.
  expect(transport.portFailure("Stdio forwarding failed")).toBe("refused");
  expect(transport.portFailure("channel 0: open failed: administratively prohibited: open failed")).toBe("prohibited");
  expect(transport.portFailure("ssh: connect to host atlas port 22: Connection refused")).toBe("unreachable");
  expect(transport.portFailure("")).toBe("unreachable");
});
