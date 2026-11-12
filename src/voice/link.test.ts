import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalLink } from "./link";
import * as websocket from "../wire_websocket";

type Request = { op: string; [key: string]: any };
/** Waits for `check`, polling, instead of a fixed sleep that load can outlast. */
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}
/** A daemon socket at `path` that, like the runtime, speaks JSON lines over
 * WebSocket; `line` hears each request with a writer to its connection. */
function daemon(path: string, line: (request: Request, write: (value: object) => void, connection: number) => void) {
  let connections = 0;
  return Bun.serve<{ id: number; buffer: string }, never>({
    unix: path,
    fetch(req, server) {
      const data = { id: ++connections, buffer: "" };
      if (server.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": websocket.protocol } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      perMessageDeflate: false,
      message(ws, chunk) {
        ws.data.buffer += chunk.toString();
        for (let end = ws.data.buffer.indexOf("\n"); end >= 0; end = ws.data.buffer.indexOf("\n")) {
          const request = JSON.parse(ws.data.buffer.slice(0, end));
          ws.data.buffer = ws.data.buffer.slice(end + 1);
          line(request, value => ws.send(Buffer.from(JSON.stringify(value) + "\n")), ws.data.id);
        }
      },
    },
  });
}
/** A runtime stand-in that answers hello and the voice ops. */
function stub(answer: (request: Request, push: (value: object) => void) => object | null = () => ({ ok: true })) {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-")),
    path = join(dir, "control.sock"),
    seen: { op: string; at: number; connection: number }[] = [];
  const server = daemon(path, (request, write, connection) => {
    seen.push({ op: request.op, at: performance.now(), connection });
    const push = (value: object) =>
      write(request.request_id === undefined ? value : { ...value, request_id: request.request_id });
    const reply =
      request.op === "hello"
        ? { type: "hello", capabilities: ["voice.watch"] }
        : request.op === "voice.watch"
          ? { ok: true, voice_id: "v-1", muted: false, viewer: true, focus: null }
          : answer(request, push);
    if (reply) push(reply);
  });
  cleanups.push(() => {
    void server.stop(true);
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
  await until(() => seen.filter(s => s.op === "voice.set").length >= 4);
  link.close();
  const watch = seen.find(s => s.op === "voice.watch")!,
    beats = seen.filter(s => s.op === "voice.set");
  expect(beats.every(b => b.connection === watch.connection)).toBe(true);
});

test("a runtime that stops answering heartbeats is lost", async () => {
  const { path } = stub(request => (request.op === "voice.set" ? null : { ok: true }));
  const link = await LocalLink.connect(path, { heartbeat_ms: 50, deadline_ms: 150 });
  const lost: string[] = [];
  link.on("closed", reason => lost.push(reason));
  await link.watch({ muted: false, available: true });
  await until(() => lost.length > 0);
  expect(lost).toEqual(["heartbeat_timeout"]);
  await expect(link.type("x")).rejects.toThrow("NotConnected");
});

test("pushed mute changes and a lost presence reach the listeners", async () => {
  let push: ((value: object) => void) | undefined,
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
  // The first heartbeat hands out the watch connection's push.
  await until(() => push !== undefined);
  push!({ type: "voice.muted", muted: true });
  await until(() => muted.length > 0);
  expect(muted).toEqual([true]);
  gone = true;
  await until(() => closed.length > 0);
  expect(closed).toEqual(["VoiceGone"]);
});

test("a daemon without the voice ops is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-")),
    path = join(dir, "control.sock");
  const server = daemon(path, (request, write) =>
    write({ type: "hello", capabilities: [], request_id: request.request_id }),
  );
  try {
    await expect(LocalLink.connect(path)).rejects.toThrow("DaemonLacksVoice");
    await expect(LocalLink.connect(join(dir, "missing.sock"))).rejects.toThrow("NoRuntime");
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
