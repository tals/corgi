import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { State } from "./prompt_search";

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
