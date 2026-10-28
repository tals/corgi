import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "./whisper";
import * as wav from "./wav";

const fake = resolve(import.meta.dir, "../../tests/fixtures/voice/whisper-server");
const saved = { ...process.env };
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
    port = probe.port;
  probe.stop(true);
  return port;
}
async function start(
  env: Record<string, string> = {},
  opts: { healthTimeoutMs?: number; vadModel?: string; language?: string; port?: number; signal?: AbortSignal } = {},
) {
  Object.assign(process.env, env);
  const server = await Server.start({ binary: fake, model: "/models/base.bin", port: freePort(), ...opts });
  servers.push(server);
  return server;
}
const utterance = wav.encode(new Int16Array(1600));
/** Whether the fake whisper-server that wrote `log` still runs; this test's own
 * child, not any other on the host. A child stopped before it wrote its first
 * line never ran. */
function stillRuns(log: string): boolean {
  let first: { pid?: number };
  try {
    first = JSON.parse(readFileSync(log, "utf8").split("\n")[0]);
  } catch {
    return false;
  }
  try {
    process.kill(first.pid!, 0);
    return true;
  } catch {
    return false;
  }
}

test("transcribes through /inference and trims the text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-whisper-")),
    log = join(dir, "log");
  try {
    const server = await start(
      { CORGI_FAKE_WHISPER_SCRIPT: "refactor the parser module", CORGI_FAKE_WHISPER_LOG: log },
      { vadModel: "/models/silero.bin", language: "auto" },
    );
    expect(await server.transcribe(utterance)).toBe("refactor the parser module");
    const lines = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(lines[0].vad).toBe(true);
    expect(lines[0].start).toContain("/models/silero.bin");
    expect(lines[0].start.join(" ")).toContain("-l auto");
    expect(lines[1].bytes).toBe(utterance.length);
    expect(lines[1].fields).toMatchObject({ temperature: "0.0", beam_size: "1", response_format: "json" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a port, the server takes a free one, and English stays the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-whisper-")),
    log = join(dir, "log");
  try {
    const server = await start(
      { CORGI_FAKE_WHISPER_SCRIPT: "hello", CORGI_FAKE_WHISPER_LOG: log },
      { port: undefined },
    );
    expect(server.port).toBeGreaterThan(0);
    expect(await server.transcribe(utterance)).toBe("hello");
    const first = JSON.parse(readFileSync(log, "utf8").split("\n")[0]);
    expect(first.start).toContain(String(server.port));
    expect(first.start).not.toContain("-l");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a port in use is refused before anything starts", async () => {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("mine") });
  try {
    await expect(
      Server.start({ binary: "/nonexistent/whisper-server", model: "m", port: holder.port! }),
    ).rejects.toThrow("PortInUse");
  } finally {
    holder.stop(true);
  }
});

test("a hung transcription times out", async () => {
  const server = await start({ CORGI_FAKE_WHISPER_MODE: "hang" }),
    started = performance.now();
  await expect(server.transcribe(utterance, { timeoutMs: 200 })).rejects.toThrow("Timeout");
  expect(performance.now() - started).toBeLessThan(1500);
});

test("an answer that is not a transcript fails instead of reading as silence", async () => {
  const server = await start({ CORGI_FAKE_WHISPER_MODE: "garbage" });
  await expect(server.transcribe(utterance)).rejects.toThrow("TranscriptionFailed");
});

test("a crash fails the request and fires crashed once", async () => {
  const server = await start({ CORGI_FAKE_WHISPER_MODE: "crash_after:1", CORGI_FAKE_WHISPER_SCRIPT: "one" }),
    crashes: (number | null)[] = [];
  server.on("crashed", code => crashes.push(code));
  expect(await server.transcribe(utterance)).toBe("one");
  await expect(server.transcribe(utterance)).rejects.toThrow("ServerDown");
  await Bun.sleep(100);
  expect(crashes).toEqual([3]);
});

test("a start given up on while the model loads stops the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-whisper-")),
    log = join(dir, "log"),
    stopping = new AbortController();
  try {
    setTimeout(() => stopping.abort(), 100);
    await expect(
      start(
        { CORGI_FAKE_WHISPER_MODE: "no_health", CORGI_FAKE_WHISPER_LOG: log },
        { healthTimeoutMs: 10_000, signal: stopping.signal },
      ),
    ).rejects.toThrow("Aborted");
    expect(stillRuns(log)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that never turns healthy is stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-whisper-")),
    log = join(dir, "log");
  try {
    await expect(
      start({ CORGI_FAKE_WHISPER_MODE: "no_health", CORGI_FAKE_WHISPER_LOG: log }, { healthTimeoutMs: 300 }),
    ).rejects.toThrow("Timeout");
    expect(stillRuns(log)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
