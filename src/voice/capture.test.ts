import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as capture from "./capture";

const fixtures = resolve(import.meta.dir, "../../tests/fixtures/voice"),
  saved = { ...process.env },
  running: capture.Capture[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const c of running.splice(0)) c.stop();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fake(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "corgi-capture-"));
  dirs.push(dir);
  Object.assign(process.env, {
    PATH: `${fixtures}:${process.env.PATH}`,
    CORGI_FAKE_FFMPEG_LOG: join(dir, "argv"),
    ...env,
  });
  return join(dir, "argv");
}
const argv = (log: string) =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("ffmpeg captures the default microphone as 16 kHz mono PCM", () => {
  expect(capture.args(null, "darwin")).toEqual([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-i",
    ":default",
    "-f",
    "s16le",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-",
  ]);
  expect(capture.args("alsa_input.usb", "linux").slice(4, 8)).toEqual(["-f", "pulse", "-i", "alsa_input.usb"]);
  expect(capture.args("1", "darwin")[7]).toBe(":1");
});

test("ffmpeg's complaints name the microphone problem", () => {
  expect(capture.classify("Failed to create AV capture input device: not authorized")).toBe("mic_denied");
  expect(capture.classify("Error opening input: Device or resource busy")).toBe("mic_busy");
  expect(capture.classify("Could not find audio device with name [x]")).toBe("mic_missing");
  expect(capture.classify("")).toBe("mic_missing");
});

test("frames arrive 20 ms at a time", async () => {
  fake({ CORGI_FAKE_PCM: join(fixtures, "speech.pcm"), CORGI_FAKE_PCM_SPEED: "20" });
  const frames: Int16Array[] = [];
  running.push(
    capture.Capture.start(
      null,
      f => frames.push(f),
      () => {},
    ),
  );
  await until(() => frames.length >= 100);
  expect(frames.every(f => f.length === 320)).toBe(true);
  expect(Math.max(...frames[10])).toBeGreaterThan(1000);
});

test("a denied, busy or missing microphone is reported", async () => {
  for (const [fail, problem] of [
    ["denied", "mic_denied"],
    ["busy", "mic_busy"],
    ["missing", "mic_missing"],
  ]) {
    fake({ CORGI_FAKE_FFMPEG_FAIL: fail });
    const problems: capture.MicProblem[] = [];
    const c = capture.Capture.start(
      null,
      () => {},
      p => problems.push(p),
    );
    running.push(c);
    await until(() => problems.length > 0);
    expect(problems[0]).toBe(problem as capture.MicProblem);
    c.stop();
  }
});

test("switching devices restarts only ffmpeg, with the new device", async () => {
  const log = fake({ CORGI_FAKE_PCM: join(fixtures, "speech.pcm") });
  const c = capture.Capture.start(
    null,
    () => {},
    () => {},
  );
  running.push(c);
  await until(() => {
    try {
      return argv(log).length === 1;
    } catch {
      return false;
    }
  });
  c.switch("1");
  await until(() => argv(log).length === 2);
  expect(argv(log)[1]).toContain(process.platform === "darwin" ? ":1" : "1");
});

test("a microphone that cannot start is reported once, and again after it worked", async () => {
  const log = fake({ CORGI_FAKE_PCM: join(fixtures, "speech.pcm") });
  const problems: capture.MicProblem[] = [],
    path = process.env.PATH!;
  let frames = 0;
  const c = capture.Capture.start(
    null,
    () => frames++,
    p => problems.push(p),
  );
  running.push(c);
  await until(() => frames > 0);
  // No ffmpeg: switching reports the problem instead of throwing, and once only.
  process.env.PATH = "/nonexistent";
  c.switch("1");
  c.switch("2");
  expect(problems).toEqual(["mic_missing"]);
  // Frames again clear it, so the next failure is news.
  process.env.PATH = path;
  const before = frames;
  c.switch("3");
  await until(() => frames > before);
  process.env.PATH = "/nonexistent";
  c.switch("4");
  expect(problems).toEqual(["mic_missing", "mic_missing"]);
  expect(argv(log).filter(a => !a.includes("-list_devices"))).toHaveLength(2);
});

test("no ffmpeg is FileNotFound", () => {
  process.env.PATH = "/nonexistent";
  expect(() =>
    capture.Capture.start(
      null,
      () => {},
      () => {},
    ),
  ).toThrow("FileNotFound");
});

test("device listings parse per platform", async () => {
  const listing = readFileSync(join(fixtures, "ffmpeg"), "utf8");
  expect(listing).toContain("AVFoundation audio devices:");
  expect(
    capture.parseAvfoundation(
      [
        "[AVFoundation indev @ 0x1] AVFoundation video devices:",
        "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera",
        "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
        "[AVFoundation indev @ 0x1] [0] Studio Microphone",
        "[AVFoundation indev @ 0x1] [1] MacBook Pro Microphone",
        "Error opening input file .",
      ].join("\n"),
    ),
  ).toEqual([
    { id: "0", label: "Studio Microphone" },
    { id: "1", label: "MacBook Pro Microphone" },
  ]);
  expect(
    capture.parseProfilerDefault(
      JSON.stringify({
        SPAudioDataType: [
          {
            _items: [
              { _name: "Studio Microphone" },
              { _name: "MacBook Pro Microphone", coreaudio_default_audio_input_device: "spaudio_yes" },
            ],
          },
        ],
      }),
    ),
  ).toBe("MacBook Pro Microphone");
  expect(capture.parseProfilerDefault("not json")).toBeNull();
  expect(
    capture.parsePulse(
      [
        "0\talsa_output.pci.analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED",
        "1\talsa_input.usb-mic\tPipeWire\ts16le 1ch 48000Hz\tRUNNING",
        "2\talsa_input.pci.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED",
      ].join("\n"),
      "alsa_input.usb-mic",
    ),
  ).toEqual([
    { id: "alsa_input.usb-mic", label: "alsa_input.usb-mic", default: true },
    { id: "alsa_input.pci.analog-stereo", label: "alsa_input.pci.analog-stereo", default: false },
  ]);
  fake();
  const { devices } = await capture.listDevices("darwin");
  expect(devices).toEqual([
    { id: "0", label: "Studio Microphone", default: false },
    { id: "1", label: "MacBook Pro Microphone", default: true },
  ]);
  process.env.PATH = "/nonexistent";
  const fallback = await capture.listDevices("linux");
  expect(fallback.devices).toEqual([{ id: "default", label: "System default", default: true }]);
  expect(fallback.notice).toBeTruthy();
});
