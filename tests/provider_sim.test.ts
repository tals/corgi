import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { deadline, registerCase, run, tempDir, TestCase } from "./support";
import {
  CodexObserver,
  NATIVE_PROVIDER,
  frame,
  write_codex_terminal,
  write_executable,
  write_ordinary_agent,
} from "./provider_sim";

async function client(path: string) {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let data = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    data = Buffer.concat([data, chunk]);
  });
  socket.write(
    "GET / HTTP/1.1\r\nHost: fixture\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  const deadline = Date.now() + 2000;
  while (data.indexOf("\r\n\r\n") < 0 && Date.now() < deadline) await Bun.sleep(2);
  const end = data.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("WebSocket handshake timed out");
  if (!data.subarray(0, end).toString().includes("101 Switching Protocols"))
    throw new Error("WebSocket handshake rejected");
  data = data.subarray(end + 4);
  const read = async () => {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      if (data.length >= 2) {
        let offset = 2,
          size = data[1] & 127;
        if (size === 126) {
          if (data.length < 4) {
            await Bun.sleep(2);
            continue;
          }
          size = data.readUInt16BE(2);
          offset = 4;
        }
        if (data.length >= offset + size) {
          const value = JSON.parse(data.subarray(offset, offset + size).toString());
          data = data.subarray(offset + size);
          return value;
        }
      }
      await Bun.sleep(2);
    }
    throw new Error("WebSocket reply timed out");
  };
  return { socket, read };
}
class Simulator extends TestCase {
  async test_frozen_response_does_not_block_another_connection() {
    const temp = tempDir("corgi-sim-");
    const sim = new CodexObserver(temp.name, ["A", "B"]);
    let first: Socket | undefined, second: Socket | undefined;
    try {
      const a = await client(sim.path),
        b = await client(sim.path);
      first = a.socket;
      second = b.socket;
      const held = sim.hold("thread/read", "A");
      a.socket.write(frame({ id: 1, method: "thread/read", params: { threadId: "A" } }));
      await held.wait();
      this.assertEqual(held.response.result.thread.status.type, "idle");
      const index = await sim.wait_for_request("thread/read", { session: "A" });
      sim.set_turn("A", "next", "inProgress", { waiting: true });
      b.socket.write(frame({ id: 2, method: "thread/read", params: { threadId: "A" } }));
      const index2 = await sim.wait_for_request("thread/read", {
        session: "A",
        after: index,
      });
      this.assertGreater(index2, index);
      const response = await b.read();
      this.assertEqual(response.id, 2);
      this.assertEqual(response.result.thread.status, {
        type: "active",
        activeFlags: ["waitingOnUserInput"],
      });
      held.release();
      this.assertEqual(await a.read(), held.response);
      b.socket.write(frame({ id: 3, method: "thread/read", params: { threadId: "B" } }));
      this.assertEqual((await b.read()).result.thread.status, {
        type: "idle",
        activeFlags: [],
      });
    } finally {
      first?.destroy();
      second?.destroy();
      await sim.close();
      temp.cleanup();
    }
    this.assertEqual(sim.errors, []);
  }
  async test_native_program_preserves_both_provider_protocols() {
    const temp = tempDir("corgi-sim-");
    try {
      const program = write_executable(join(temp.name, "provider"), NATIVE_PROVIDER);
      for (const [provider, args] of [
        ["codex", []],
        ["claude", ["--print"]],
      ] as const) {
        const messages = [
          { id: 1, method: "initialize" },
          { method: "test/approval" },
          provider === "codex" ? { id: 900 } : { type: "control_response" },
          { method: "test/exit" },
        ];
        const result = await run([program, ...args], {
          input: messages.map(v => JSON.stringify(v) + "\n").join(""),
          timeout: 3000,
        });
        const events = result.stdout
          .trim()
          .split("\n")
          .map(v => JSON.parse(v));
        this.assertEqual(events[0], { id: 1, result: { version: "fixture" } });
        if (provider === "codex") {
          this.assertEqual(events[1].method, "turn/started");
          this.assertEqual(events[2].method, "item/commandExecution/requestApproval");
          this.assertEqual(events[3].method, "turn/completed");
        } else {
          this.assertEqual(events[1].type, "control_request");
          this.assertEqual(events[2].type, "result");
        }
        this.assertEqual(result.stderr, "");
      }
    } finally {
      temp.cleanup();
    }
  }
  async test_terminal_programs_emit_real_titles_and_screen_sequences() {
    const temp = tempDir("corgi-sim-");
    try {
      const root = temp.name;
      const terminal = write_codex_terminal(join(root, "codex"), "A".repeat(36));
      const result = await run([terminal, "resume"], {
        input: "B\n",
        timeout: 3000,
      });
      this.assertIn('ARGS:["resume"]', result.stdout);
      this.assertIn("\x1b]0;codex | " + "A".repeat(29) + "...\x07", result.stdout);
      this.assertTrue(result.stdout.endsWith("\x1b]0;codex | B\x07"));
      const ordinary = write_ordinary_agent(join(root, "claude"));
      const env = {
        ...process.env,
        HOME: root,
        CODEX_HOME: join(root, ".codex"),
        CLAUDE_CONFIG_DIR: join(root, ".claude"),
      };
      const output = await run([ordinary, "--loading"], {
        env,
        input: "ready\nwork\nblock\nstop\nexit\n",
        timeout: 3000,
      });
      this.assertIn("Initializing (esc to interrupt)", output.stdout);
      this.assertIn("Working (esc to interrupt)", output.stdout);
      this.assertIn("enter to confirm or esc to cancel", output.stdout);
      this.assertEqual(output.stdout.split("\x1b]2;✳ Ready\x07").length - 1, 2);
      this.assertEqual(output.stderr, "");
    } finally {
      temp.cleanup();
    }
  }
  async test_terminal_programs_exit_with_stdin_still_open() {
    const temp = tempDir("corgi-sim-");
    try {
      const codex = write_codex_terminal(join(temp.name, "codex"), "A".repeat(36));
      const claude = write_ordinary_agent(join(temp.name, "claude"));
      const env = {
        ...process.env,
        HOME: temp.name,
        CODEX_HOME: join(temp.name, ".codex"),
        CLAUDE_CONFIG_DIR: join(temp.name, ".claude"),
      };
      for (const program of [codex, claude]) {
        const proc = Bun.spawn([program], {
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          const input = proc.stdin as Bun.FileSink;
          input.write("exit\n");
          await input.flush();
          this.assertEqual(await deadline(proc.exited, 2000, `${program} did not exit with stdin open`), 0);
        } finally {
          if (proc.exitCode === null) {
            proc.kill("SIGKILL");
            await proc.exited;
          }
          (proc.stdin as Bun.FileSink).end();
        }
      }
    } finally {
      temp.cleanup();
    }
  }
}
registerCase("Simulator", Simulator, { inherited: false });
