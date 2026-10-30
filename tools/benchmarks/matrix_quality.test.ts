import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as quality from "./matrix_quality";
import * as streaming from "./streaming_fixture";

type Counter = Awaited<ReturnType<typeof quality.counters>>[number];
function counter(): Counter {
  return {
    pid: 123,
    start_ticks: "100",
    wchar: "200",
    syscw: "5",
    terminal: {
      schema: "terminal-io-v1",
      pid: 123,
      at_ns: "1000000",
      stdout_bytes: 26,
      stdout_writes: 1,
      stderr_bytes: 0,
      stderr_writes: 0,
    },
    transcript: {
      path: "/fixture/ordinary-claude-123.jsonl",
      dev: "1",
      ino: "2",
      size: "67",
      mtime_ns: "3",
      ctime_ns: "3",
      sha256: "unchanged",
    },
  };
}
function changed(edit: (value: Counter) => void) {
  const before = counter(),
    after = counter();
  after.terminal.at_ns = "2000000";
  edit(after);
  return quality.idle([before], [after], ["› \n"], ["› \n"]);
}

test("idle proof distinguishes internal descriptor writes from terminal writes of any size", () => {
  const internal = changed(value => {
    value.wchar = "208";
    value.syscw = "6";
  });
  expect(internal).toMatchObject({ valid: true, no_terminal_writes: true, all_fd_io_unchanged: false });
  for (const bytes of [1, 8, 16]) {
    const terminal = changed(value => {
      value.wchar = String(Number(value.wchar) + bytes);
      value.syscw = "6";
      value.terminal.stdout_bytes += bytes;
      value.terminal.stdout_writes++;
    });
    expect(terminal).toMatchObject({ valid: false, no_terminal_writes: false, stable_prompts: true });
    expect(() => quality.validate(terminal)).toThrow();
  }
  expect(changed(value => value.terminal.stderr_bytes++)).toMatchObject({ valid: false });
});

test("idle proof rejects changed transcripts, identity and stale receipts", () => {
  for (const edit of [
    (value: Counter) => (value.transcript.size = "68"),
    (value: Counter) => (value.transcript.mtime_ns = "4"),
    (value: Counter) => (value.transcript.ctime_ns = "4"),
    (value: Counter) => (value.transcript.ino = "3"),
    (value: Counter) => (value.transcript.sha256 = "changed"),
    (value: Counter) => (value.start_ticks = "101"),
    (value: Counter) => value.pid++,
    (value: Counter) => (value.terminal.at_ns = "1000000"),
  ])
    expect(changed(edit).valid).toBe(false);
});

async function until(read: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!read()) {
    if (Date.now() >= deadline) throw Error("Fixture output deadline missed");
    await Bun.sleep(5);
  }
}

test("counted fixture keeps prompt bytes and rejects an eight-byte invisible PTY write", async () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-terminal-counter-")),
    binary = join(home, "bin", "claude"),
    marker = join(home, "signal-step");
  streaming.install(join(home, "bin"), "sparse");
  const signal = `
import { dlopen } from 'bun:ffi';
import { writeSync as internalWrite } from 'node:fs';
const libc = dlopen('libc.so.6', { eventfd: { args: ['u32', 'i32'], returns: 'i32' } });
const wake = libc.symbols.eventfd(0, 0);
let signals = 0;
process.on('SIGUSR1', () => {
  if (signals++ === 0) internalWrite(wake, Buffer.from([1,0,0,0,0,0,0,0]));
  else writeTerminal(1, '\\x1b[0m\\x1b[0m');
  writeFileSync(${JSON.stringify(marker)}, String(signals));
});
`;
  writeFileSync(
    binary,
    readFileSync(binary, "utf8")
      .replace("handle, observeTerminal, terminalLog", "handle, observeTerminal, terminalLog, writeTerminal")
      .replace("let turn=0;", signal + "\nlet turn=0;"),
  );
  let output = "";
  const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data: (_terminal, bytes) => {
        output += Buffer.from(bytes).toString();
      },
    }),
    proc = Bun.spawn([process.execPath, binary], {
      terminal,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, CPU_RICH_TRANSCRIPTS: "" },
    });
  try {
    await until(() => output.includes("› "));
    expect(output.replaceAll("\r\n", "\n")).toBe("\x1b[2J\x1b[H\x1b]2;✳ Ready\x07› \n");
    const first = await quality.counters(home, [proc.pid]);
    expect(first[0].terminal).toMatchObject({ stdout_bytes: 26, stdout_writes: 1, stderr_bytes: 0 });
    process.kill(proc.pid, "SIGUSR1");
    await until(() => existsSync(marker));
    const internal = await quality.counters(home, [proc.pid]);
    expect(quality.idle(first, internal, ["› \n"], ["› \n"])).toMatchObject({
      valid: true,
      all_fd_io_unchanged: false,
      no_terminal_writes: true,
      unchanged_transcripts: true,
    });
    process.kill(proc.pid, "SIGUSR1");
    await until(() => output.endsWith("\x1b[0m\x1b[0m"));
    const written = await quality.counters(home, [proc.pid]);
    expect(written[0].terminal.stdout_bytes - internal[0].terminal.stdout_bytes).toBe(8);
    expect(quality.idle(internal, written, ["› \n"], ["› \n"])).toMatchObject({
      valid: false,
      no_terminal_writes: false,
      stable_prompts: true,
    });
  } finally {
    proc.kill();
    await proc.exited;
    terminal.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("counted controlled streaming preserves the exact sparse payload bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "corgi-stream-counter-")),
    directory = join(home, "traces");
  mkdirSync(directory);
  streaming.install(join(home, "bin"), "sparse");
  const proc = Bun.spawn([process.execPath, join(home, "bin", "claude")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, CPU_RICH_TRANSCRIPTS: "" },
  });
  let output = "";
  const read = (async () => {
      for await (const bytes of proc.stdout) output += Buffer.from(bytes).toString();
    })(),
    errors = new Response(proc.stderr).text();
  const send = async (command: string) => {
    proc.stdin.write(command + "\n");
    await proc.stdin.flush();
  };
  const payload = (index: number) => "\x1b[1;1HWorking (esc to interrupt) " + index + " " + ".".repeat(100) + "\x1b[K";
  try {
    await until(() => output.includes("› "));
    await send(
      "bench-stream-arm " +
        JSON.stringify({
          token: "payload-check",
          directory,
          epoch_ns: String(streaming.now() + 1_500_000_000n),
          lane: 0,
          lanes: 1,
          schedule: "staggered",
          capacity: 32,
        }),
    );
    await until(() => output.includes(payload(3)));
    await send("quiet");
    await send("exit");
    expect(await proc.exited).toBe(0);
    await read;
    expect(await errors).toBe("");
    expect(output).toBe(
      "\x1b[2J\x1b[H\x1b]2;✳ Ready\x07› \n" +
        "\x1b[2J\x1b[HWorking (esc to interrupt)" +
        [1, 2, 3].map(payload).join(""),
    );
  } finally {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
    await read;
    rmSync(home, { recursive: true, force: true });
  }
});
