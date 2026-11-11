import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Server, subtitles } from "./whisper";
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
    expect(await server.transcribe(utterance, { padMs: 1000 })).toEqual({ text: "refactor the parser module" });
    const lines = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(lines[0].vad).toBe(true);
    expect(lines[0].start).toContain("/models/silero.bin");
    expect(lines[0].start.join(" ")).toContain("-l auto");
    expect(lines[1].bytes).toBe(utterance.length);
    // The filter pads by the post-roll; without segments, plain json.
    expect(lines[1].fields).toMatchObject({
      temperature: "0.0",
      beam_size: "1",
      response_format: "json",
      vad_speech_pad_ms: "1000",
    });
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
    expect(await server.transcribe(utterance)).toEqual({ text: "hello" });
    const [first, request] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(first.start).toContain(String(server.port));
    expect(first.start).not.toContain("-l");
    // Without a padding, the server keeps its own.
    expect(request.fields).not.toHaveProperty("vad_speech_pad_ms");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asked for segments, it reads subtitles and where the last one ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-whisper-")),
    log = join(dir, "log");
  try {
    const server = await start({
      CORGI_FAKE_WHISPER_MODE: "segments:1.2,4.27",
      CORGI_FAKE_WHISPER_SCRIPT: "run the tests|again",
      CORGI_FAKE_WHISPER_LOG: log,
    });
    // The cues' text reads as json's does, a segment a line.
    expect(await server.transcribe(utterance, { padMs: 2500, segments: true })).toEqual({
      text: "run the tests\n again",
      speech_end: 4.27,
    });
    // Never verbose_json: whisper-server 1.9.5 crashes on it when the filter finds no speech.
    const request = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[1]);
    expect(request.fields).toMatchObject({ response_format: "srt", vad_speech_pad_ms: "2500" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cue's text runs to the next cue, blank lines and all", () => {
  // As whisper-server writes it: each segment's text, then a blank line.
  const srt = "1\n00:00:00,000 --> 00:00:02,000\n\n hello there\n\n2\n00:00:02,000 --> 01:01:01,230\n one\n\n two\n\n";
  expect(subtitles(srt)).toEqual({ text: "hello there\n one\n\n two", speech_end: 3661.23 });
  expect(subtitles(srt.replaceAll("\n", "\r\n")).speech_end).toBe(3661.23);
});

test("subtitles without cues are silence; other replies fail", async () => {
  const silent = await start({ CORGI_FAKE_WHISPER_SCRIPT: "" });
  expect(await silent.transcribe(utterance, { segments: true })).toStrictEqual({ text: "" });
  const garbage = await start({ CORGI_FAKE_WHISPER_MODE: "garbage" });
  await expect(garbage.transcribe(utterance, { segments: true })).rejects.toThrow("TranscriptionFailed");
  const no_text = await start({ CORGI_FAKE_WHISPER_MODE: "no_text" });
  await expect(no_text.transcribe(utterance)).rejects.toThrow("TranscriptionFailed");
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
  expect(await server.transcribe(utterance)).toEqual({ text: "one" });
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
