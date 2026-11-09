import { test, expect } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { nativeRoot } from "./native_paths";
import { Preamble } from "./daemon_transport";

const marker = Buffer.from("\ncorgi-bridge-v1\n");

test("bridge framing discards fragmented banners and preserves binary bytes", async () => {
  const stream = new Preamble();
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
  for (const bytes of [Buffer.alloc(65537, 65), Buffer.from("banner only")]) {
    const stream = new Preamble();
    const error = new Promise<Error>(resolve => stream.on("error", resolve));
    stream.resume();
    stream.end(bytes);
    expect(await error).toBeInstanceOf(Error);
  }
});

test("native bridge carries binary data and drains replies after stdin EOF", async () => {
  const dir = mkdtempSync("/tmp/corgi-bridge-test-");
  const input = Buffer.alloc(512 * 1024);
  for (let i = 0; i < input.length; i++) input[i] = i % 256;
  const received: Buffer[] = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.on("data", chunk => received.push(Buffer.from(chunk)));
    socket.on("end", () => socket.end(Buffer.concat([Buffer.concat(received), Buffer.from("tail")])));
  });
  await new Promise<void>(resolve => server.listen(dir + "/s", resolve));
  const child = Bun.spawn([nativeRoot + "/bin/corgi-remote-bridge", dir + "/s"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const output = new Response(child.stdout).arrayBuffer();
    child.stdin.write(input);
    await child.stdin.end();
    expect(Buffer.from(await output)).toEqual(Buffer.concat([marker, input, Buffer.from("tail")]));
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native bridge accepts input while stdout is backpressured", async () => {
  const dir = mkdtempSync("/tmp/corgi-bridge-test-");
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
  await new Promise<void>(resolve => server.listen(dir + "/s", resolve));
  const child = Bun.spawn([nativeRoot + "/bin/corgi-remote-bridge", dir + "/s"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await Bun.sleep(100);
    child.stdin.write("INPUT_WHILE_OUTPUT_BLOCKED");
    await child.stdin.flush();
    const until = performance.now() + 2000;
    while (!received && performance.now() < until) await Bun.sleep(10);
    expect(received).toBe("INPUT_WHILE_OUTPUT_BLOCKED");
    child.kill();
    await child.exited;
  } finally {
    child.kill();
    peer?.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
