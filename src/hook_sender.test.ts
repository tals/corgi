//! native/hook.zig: how long `corgi-hook` may hold up an agent, and what it
//! notes when Corgi doesn't answer.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { flock } from "./native_bridge";
import { nativeRoot } from "./native_paths";
import * as start_lock from "./start_lock";
import * as text from "./text";

const sender = `${nativeRoot}/bin/corgi-hook`;

function directory() {
  const root = fs.mkdtempSync("/tmp/corgi-hook-");
  return {
    root,
    socket: root + "/s",
    log: () => (fs.existsSync(root + "/hooks.log") ? fs.readFileSync(root + "/hooks.log", "utf8") : ""),
    backoff: root + "/hooks.backoff",
    [Symbol.dispose]: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
/** Runs the sender for one event; how long it took. */
async function send(socket: string): Promise<number> {
  const started = performance.now();
  const child = Bun.spawn([sender, "hook", "claude"], {
    env: { PATH: process.env.PATH ?? "", CORGI_PANE: "1", CORGI_SOCKET: socket },
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s" })),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
  return performance.now() - started;
}
/** A daemon that takes connections and reads requests: answering them with
 * `status`, or not at all. */
async function daemon(socket: string, answer: boolean, status = () => "200 OK") {
  const received: string[] = [];
  const server = net.createServer(peer => {
    peer.on("error", () => {});
    peer.on("data", chunk => {
      received.push(String(chunk));
      const reply = '{"ok":true}';
      if (answer)
        peer.end(
          `HTTP/1.1 ${status()}\r\nContent-Length: ${text.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`,
        );
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  return { received, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("with no daemon, the hook returns at once and notes nothing", async () => {
  using dir = directory();
  expect(await send(dir.socket)).toBeLessThan(500);
  expect(dir.log()).toBe("");
});

test("a daemon that doesn't answer twice in a row costs two hooks 2 s each, noted, and the next ones nothing", async () => {
  using dir = directory();
  const wedged = await daemon(dir.socket, false);
  try {
    for (const then of ["hooks keep trying", "hooks skip Corgi for 30 s"]) {
      const waited = await send(dir.socket);
      expect(waited).toBeGreaterThan(1900);
      expect(waited).toBeLessThan(2900);
      expect(dir.log()).toMatch(new RegExp(`pid \\d+: claude PreToolUse: no reply after 2\\d\\d\\d ms; ${then}\n$`));
    }
    const count = wedged.received.length;
    expect(await send(dir.socket)).toBeLessThan(500);
    expect(wedged.received.length).toBe(count);
  } finally {
    await wedged.close();
  }
});

test("hooks that time out together each count", async () => {
  using dir = directory();
  const wedged = await daemon(dir.socket, false);
  try {
    for (const waited of await Promise.all([send(dir.socket), send(dir.socket)])) expect(waited).toBeLessThan(2900);
    expect(fs.readFileSync(dir.backoff, "utf8")).toMatch(/^2 [1-9]\d*\n$/);
    expect(dir.log().match(/; hooks skip Corgi for 30 s\n/g)).toHaveLength(1);
  } finally {
    await wedged.close();
  }
});

test("a hook stuck counting holds up the next one's count, not its agent", async () => {
  using dir = directory();
  const wedged = await daemon(dir.socket, false),
    stuck = fs.openSync(dir.backoff, "a+", 0o600);
  expect(flock(stuck)).toBe(true);
  try {
    expect(await send(dir.socket)).toBeLessThan(2900);
    expect(fs.readFileSync(dir.backoff, "utf8")).toBe("");
    expect(dir.log()).toMatch(/no reply after 2\d\d\d ms; hooks keep trying\n$/);
  } finally {
    fs.closeSync(stuck);
    await wedged.close();
  }
});

test("a reply whose status line comes in pieces delivers the event once", async () => {
  using dir = directory();
  let requests = 0;
  const server = net.createServer(peer => {
    peer.on("error", () => {});
    peer.once("data", async () => {
      requests++;
      const reply = '{"ok":true}';
      peer.write("HTTP/1.1 20");
      await Bun.sleep(20);
      peer.end(`0 OK\r\nContent-Length: ${text.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`);
    });
  });
  await new Promise<void>(resolve => server.listen(dir.socket, resolve));
  try {
    expect(await send(dir.socket)).toBeLessThan(1000);
    expect(requests).toBe(1);
    expect(dir.log()).toBe("");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a hook that gets through ends the back-off", async () => {
  using dir = directory();
  // A timeout before, whose back-off is over.
  fs.writeFileSync(dir.backoff, "2 0\n");
  const healthy = await daemon(dir.socket, true);
  try {
    expect(await send(dir.socket)).toBeLessThan(1000);
    expect(healthy.received.join("")).toContain('"hook_event_name":"PreToolUse"');
    expect(fs.existsSync(dir.backoff)).toBe(false);
  } finally {
    await healthy.close();
  }
});

test("while a daemon starts, the hook waits for it, within 3 s", async () => {
  using dir = directory();
  const lock = (await start_lock.take(dir.socket))!;
  let started: Awaited<ReturnType<typeof daemon>> | null = null;
  const later = setTimeout(async () => {
    started = await daemon(dir.socket, true);
    start_lock.release(lock);
  }, 300);
  try {
    const waited = await send(dir.socket);
    expect(waited).toBeGreaterThan(250);
    expect(waited).toBeLessThan(2000);
    expect(started!.received.join("")).toContain("PreToolUse");
    expect(dir.log()).toBe("");
  } finally {
    clearTimeout(later);
    await (started as Awaited<ReturnType<typeof daemon>> | null)?.close();
  }
});

test("a start that never finishes holds the hook 3 s at most", async () => {
  using dir = directory();
  const lock = (await start_lock.take(dir.socket))!;
  try {
    const waited = await send(dir.socket);
    expect(waited).toBeGreaterThan(2900);
    expect(waited).toBeLessThan(3900);
    expect(dir.log()).toContain("the reload or start didn't finish");
  } finally {
    start_lock.release(lock);
  }
});

test("a full daemon's refusal is sent again while it reloads, and given up otherwise", async () => {
  using dir = directory();
  let refusals = 2;
  const full = await daemon(dir.socket, true, () => (refusals-- > 0 ? "503 Service Unavailable" : "200 OK"));
  try {
    expect(await send(dir.socket)).toBeLessThan(500);
    expect(full.received).toHaveLength(2);
    const lock = (await start_lock.take(dir.socket))!;
    try {
      refusals = 2;
      expect(await send(dir.socket)).toBeLessThan(2000);
      expect(full.received).toHaveLength(5);
    } finally {
      start_lock.release(lock);
    }
    expect(dir.log()).toBe("");
  } finally {
    await full.close();
  }
});
