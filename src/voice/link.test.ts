import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalLink } from "./link";

type Request = { op: string; [key: string]: any };
/** A runtime stand-in that answers hello and the voice ops. */
function stub(answer: (request: Request, push: (value: object) => void) => object | null = () => ({ ok: true })) {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-")),
    path = join(dir, "control.sock"),
    seen: { op: string; at: number; connection: number }[] = [];
  let connections = 0;
  const server = Bun.listen<{ id: number; buffer: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { id: ++connections, buffer: "" };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        for (let end = socket.data.buffer.indexOf("\n"); end >= 0; end = socket.data.buffer.indexOf("\n")) {
          const request = JSON.parse(socket.data.buffer.slice(0, end));
          socket.data.buffer = socket.data.buffer.slice(end + 1);
          seen.push({ op: request.op, at: performance.now(), connection: socket.data.id });
          const push = (value: object) => socket.write(JSON.stringify(value) + "\n");
          const reply =
            request.op === "hello"
              ? { type: "hello", capabilities: ["voice.watch"] }
              : request.op === "voice.watch"
                ? { ok: true, voice_id: "v-1", muted: false }
                : answer(request, push);
          if (reply) push(reply);
        }
      },
    },
  });
  cleanups.push(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, seen };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("a hung request times out without holding up the next", async () => {
  let hung = false;
  const { path } = stub(request => {
    if (request.op !== "voice.type") return { ok: true };
    if (!hung) {
      hung = true;
      return null;
    }
    return { ok: true, pane: 4, viewer: 2 };
  });
  const link = await LocalLink.connect(path, { deadline_ms: 200 });
  await link.watch({ muted: false, available: true });
  const started = performance.now();
  await expect(link.type("first")).rejects.toThrow("Timeout");
  expect(performance.now() - started).toBeLessThan(1000);
  const next = performance.now();
  expect(await link.type("second")).toEqual({ pane: 4, viewer: 2 });
  expect(performance.now() - next).toBeLessThan(150);
  link.close();
});

test("heartbeats renew the presence on the watch connection", async () => {
  const { path, seen } = stub();
  const link = await LocalLink.connect(path, { heartbeat_ms: 50 });
  await link.watch({ muted: false, available: true });
  await Bun.sleep(280);
  link.close();
  const watch = seen.find(s => s.op === "voice.watch")!,
    beats = seen.filter(s => s.op === "voice.set");
  expect(beats.length).toBeGreaterThanOrEqual(4);
  expect(beats.every(b => b.connection === watch.connection)).toBe(true);
});

test("a runtime that stops answering heartbeats is lost", async () => {
  const { path } = stub(request => (request.op === "voice.set" ? null : { ok: true }));
  const link = await LocalLink.connect(path, { heartbeat_ms: 50, deadline_ms: 150 });
  const lost: string[] = [];
  link.on("closed", reason => lost.push(reason));
  await link.watch({ muted: false, available: true });
  const end = Date.now() + 2000;
  while (!lost.length && Date.now() < end) await Bun.sleep(10);
  expect(lost).toEqual(["heartbeat_timeout"]);
  await expect(link.type("x")).rejects.toThrow("NotConnected");
});

test("pushed mute changes and a lost presence reach the listeners", async () => {
  let push!: (value: object) => void,
    gone = false;
  const { path } = stub((request, send) => {
    push = send;
    return request.op === "voice.set" && gone ? { err: "VoiceGone" } : { ok: true };
  });
  const link = await LocalLink.connect(path, { heartbeat_ms: 30 }),
    muted: boolean[] = [],
    closed: string[] = [];
  link.on("muted", m => muted.push(m));
  link.on("closed", r => closed.push(r));
  await link.watch({ muted: false, available: true });
  await Bun.sleep(50);
  push({ type: "voice.muted", muted: true });
  await Bun.sleep(20);
  expect(muted).toEqual([true]);
  gone = true;
  await Bun.sleep(80);
  expect(closed).toEqual(["VoiceGone"]);
});

test("a daemon without the voice ops is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-")),
    path = join(dir, "control.sock");
  const server = Bun.listen({
    unix: path,
    socket: { data: socket => void socket.write(JSON.stringify({ type: "hello", capabilities: [] }) + "\n") },
  });
  try {
    await expect(LocalLink.connect(path)).rejects.toThrow("DaemonLacksVoice");
    await expect(LocalLink.connect(join(dir, "missing.sock"))).rejects.toThrow("NoRuntime");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
