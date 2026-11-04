import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { State } from "./prompt_search";
import { Reporter } from "./prompt_search_report";

test("grep publishes on a separate socket before producing its final stdout", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "corgi-search-live-"))),
    home = path.join(dir, "home"),
    sessions = path.join(home, ".codex", "sessions"),
    socketPath = path.join(dir, "s.sock");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "found.jsonl"),
    [
      { type: "session_meta", payload: { id: "found-session", cwd: "/project" } },
      {
        type: "response_item",
        timestamp: new Date().toISOString(),
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "emoji branch/fix" }] },
      },
    ]
      .map(r => JSON.stringify(r) + "\n")
      .join(""),
  );
  const states: State[] = [],
    buffers = new Map<object, string>();
  let childExited = false,
    sawBeforeExit = false;
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, bytes) {
        let buffer = (buffers.get(socket) ?? "") + Buffer.from(bytes).toString();
        for (;;) {
          const n = buffer.indexOf("\n");
          if (n < 0) break;
          const request = JSON.parse(buffer.slice(0, n));
          buffer = buffer.slice(n + 1);
          expect(request.op).toBe("headless.search");
          expect(request.id).toBe(7);
          states.push(request.search);
          const reply = () => socket.write(JSON.stringify({ ok: true, request_id: request.request_id }) + "\n");
          if (request.search.phase === "searching" && request.search.found === 1 && sawBeforeExit === false) {
            // The search waits for the prompt to take each update, even one with a match.
            setTimeout(() => {
              sawBeforeExit ||= !childExited;
              reply();
            }, 100);
          } else reply();
        }
        buffers.set(socket, buffer);
      },
      close(socket) {
        buffers.delete(socket);
      },
    },
  });
  try {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "main.ts"), "grep", "--workspace", "/project", "-F", "emoji"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          XDG_CACHE_HOME: path.join(dir, "cache"),
          XDG_STATE_HOME: path.join(dir, "state"),
          CORGI_SOCKET: socketPath,
          CORGI_HEADLESS_ID: "7",
          ...(process.env.CORGI_NATIVE_ROOT ? { CORGI_NATIVE_ROOT: process.env.CORGI_NATIVE_ROOT } : {}),
        },
      },
    );
    const exited = child.exited.then(code => {
      childExited = true;
      return code;
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      exited,
    ]);
    expect(error).not.toContain("Error");
    expect(code).toBe(0);
    expect(out).toContain("1:assistant:emoji branch/fix");
    expect(out).not.toContain("searching");
    expect(sawBeforeExit).toBe(true);
    expect(states[0]).toMatchObject({ phase: "checking", expression: "emoji", workspace: "/project" });
    expect(states[1]).toMatchObject({ phase: "searching", found: 0, total: 1 });
    expect(states.at(-1)).toMatchObject({
      phase: "done",
      found: 1,
      scanned: 1,
      matches: [{ provider: "codex", session: "found-session" }],
    });
    expect(new Set(states.map(s => s.id)).size).toBe(1);
    expect(states.map(s => s.revision)).toEqual(states.map((_, i) => i + 1));
  } finally {
    listener.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
/** A daemon socket that answers every request and keeps what it was sent. */
async function daemon(): Promise<{ socket: string; heard: any[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corgi-report-")),
    socket = path.join(dir, "control.sock"),
    heard: any[] = [];
  const server = createServer(connection => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        heard.push(request);
        connection.write(JSON.stringify({ ok: true, request_id: request.request_id }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  cleanups.push(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { socket, heard };
}

test("only a command run for a prompt session reports to it", () => {
  expect(Reporter.here({})).toBeNull();
  expect(Reporter.here({ CORGI_SOCKET: "/s" })).toBeNull();
  expect(Reporter.here({ CORGI_SOCKET: "/s", CORGI_HEADLESS_ID: "0" })).toBeNull();
  expect(Reporter.here({ CORGI_SOCKET: "/s", CORGI_HEADLESS_ID: "x" })).toBeNull();
  expect(Reporter.here({ CORGI_SOCKET: "/s", CORGI_HEADLESS_ID: "7" })).toBeInstanceOf(Reporter);
});

test("each memory line goes to the session in order, each waiting for its reply", async () => {
  const { socket, heard } = await daemon(),
    reporter = Reporter.here({ CORGI_SOCKET: socket, CORGI_HEADLESS_ID: "7" })!;
  await reporter.memory({ file: "/m/2026-10-30.md", line: "- Ships Fridays", edited: false });
  await reporter.memory({ file: "/m/MEMORY.md", line: "- CI is fast", edited: true });
  reporter.close();
  expect(heard).toEqual([
    { op: "headless.memory", id: 7, file: "/m/2026-10-30.md", line: "- Ships Fridays", edited: false, request_id: 1 },
    { op: "headless.memory", id: 7, file: "/m/MEMORY.md", line: "- CI is fast", edited: true, request_id: 2 },
  ]);
});

test("a daemon that isn't there leaves the command to finish", async () => {
  const reporter = Reporter.here({
    CORGI_SOCKET: path.join(os.tmpdir(), "corgi-no-such.sock"),
    CORGI_HEADLESS_ID: "7",
  })!;
  await reporter.memory({ file: "/m/MEMORY.md", line: "- x", edited: false });
  await reporter.memory({ file: "/m/MEMORY.md", line: "- y", edited: false });
  reporter.close();
});
