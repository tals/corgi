import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as rpc_http from "./rpc_http";
import * as start_lock from "./start_lock";

function directory() {
  const root = fs.mkdtempSync("/tmp/corgi-lock-");
  return { socket: root + "/s", [Symbol.dispose]: () => fs.rmSync(root, { recursive: true, force: true }) };
}
/** Answers each POST with `{ok: true}`. */
function daemon(socket: string) {
  return Bun.serve({ unix: socket, fetch: () => Response.json({ ok: true }) });
}

test("the lock is held until every holder closes it", async () => {
  using dir = directory();
  expect(start_lock.held(dir.socket)).toBe(false);
  const fd = (await start_lock.take(dir.socket))!;
  expect(fd).toBeGreaterThanOrEqual(0);
  expect(start_lock.held(dir.socket)).toBe(true);
  expect(await start_lock.take(dir.socket, 30)).toBeNull();
  start_lock.release(fd);
  expect(start_lock.held(dir.socket)).toBe(false);
});

test("a request waits for a daemon only while the lock is held", async () => {
  using dir = directory();
  await expect(new rpc_http.Client(dir.socket).post({ op: "hello" })).rejects.toMatchObject({ code: "ENOENT" });
  const fd = (await start_lock.take(dir.socket))!;
  let server: ReturnType<typeof daemon> | null = null;
  setTimeout(() => {
    server = daemon(dir.socket);
    start_lock.release(fd);
  }, 150);
  try {
    expect(await new rpc_http.Client(dir.socket).post({ op: "hello" })).toEqual({ ok: true });
  } finally {
    (server as ReturnType<typeof daemon> | null)?.stop(true);
  }
});

test("a waiting request gives up after its limit", async () => {
  using dir = directory();
  const fd = (await start_lock.take(dir.socket))!;
  try {
    const started = performance.now();
    await expect(new rpc_http.Client(dir.socket).post({ op: "hello" }, 1000, 120)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
  } finally {
    start_lock.release(fd);
  }
});

test("only a refused, missing or dropped connection waits, and only while held", async () => {
  using dir = directory();
  const error = (code: string) => Object.assign(Error(code), { code });
  expect(start_lock.waitable(dir.socket, error("ENOENT"))).toBe(false);
  const fd = (await start_lock.take(dir.socket))!;
  try {
    for (const code of ["ENOENT", "ECONNREFUSED", "ECONNRESET"])
      expect(start_lock.waitable(dir.socket, error(code))).toBe(true);
    expect(start_lock.waitable(dir.socket, error("EACCES"))).toBe(false);
    expect(start_lock.waitable(dir.socket, Error("RequestTimedOut"))).toBe(false);
  } finally {
    start_lock.release(fd);
  }
});
