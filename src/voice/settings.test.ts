import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as settings from "./settings";

const dir = mkdtempSync(join(tmpdir(), "corgi-voice-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string) => {
  const at = join(dir, name);
  writeFileSync(at, content);
  return at;
};

test("a missing file gives the defaults without notices", () => {
  expect(settings.read(join(dir, "absent.json"))).toEqual({
    settings: {
      threshold: 44,
      silence: 2.5,
      pre_roll: 0.3,
      min_speech: 0.2,
      burst: 0.1,
      model: "base.en",
      port: null,
      speech_filter: true,
      device: null,
    },
    notices: [],
  });
});

test("valid fields are read", () => {
  const { settings: s, notices } = settings.read(
    file(
      "valid.json",
      JSON.stringify({
        threshold: 60,
        silence: 1.5,
        pre_roll: 0.5,
        min_speech: 0.1,
        burst: 0.05,
        model: "small.en",
        port: 9000,
        speech_filter: false,
        device: "1",
        // Unknown keys, such as the command words of earlier builds, are ignored.
        commands: { submit: ["send", "done"] },
        unknown: true,
      }),
    ),
  );
  expect(notices).toEqual([]);
  expect(s).toEqual({
    threshold: 60,
    silence: 1.5,
    pre_roll: 0.5,
    min_speech: 0.1,
    burst: 0.05,
    model: "small.en",
    port: 9000,
    speech_filter: false,
    device: "1",
  });
});

test("each invalid field falls back with one notice", () => {
  const { settings: s, notices } = settings.read(
    file(
      "invalid.json",
      JSON.stringify({
        threshold: 101,
        silence: 0.1,
        pre_roll: -1,
        min_speech: 5,
        burst: "short",
        model: "large",
        port: 80,
        speech_filter: "yes",
        device: "",
      }),
    ),
  );
  expect(s).toEqual(settings.defaults());
  expect(notices).toEqual([
    'voice.json: "threshold" must be 0..100; using 44',
    'voice.json: "silence" must be 0.5..10; using 2.5',
    'voice.json: "pre_roll" must be 0..2; using 0.3',
    'voice.json: "min_speech" must be 0.02..2; using 0.2',
    'voice.json: "burst" must be 0.02..1; using 0.1',
    'voice.json: "model" must be tiny.en|base.en|small.en|medium|large-v3-turbo; using "base.en"',
    'voice.json: "port" must be 1024..65535 or null; using null',
    'voice.json: "speech_filter" must be true or false; using true',
    'voice.json: "device" must be a device name or null; using null',
  ]);
});

test("an unreadable file gives the defaults and one notice", () => {
  for (const [name, content] of [
    ["broken.json", "{"],
    ["array.json", "[]"],
    ["big.json", JSON.stringify({ pad: "x".repeat(70 * 1024) })],
  ]) {
    const { settings: s, notices } = settings.read(file(name, content));
    expect(s).toEqual(settings.defaults());
    expect(notices).toHaveLength(1);
  }
});

test("flags override the file for one run", () => {
  const merged = settings.merge(settings.defaults(), { model: "tiny.en", threshold: 30, speech_filter: false });
  expect(merged).toMatchObject({ model: "tiny.en", threshold: 30, speech_filter: false, port: null });
  expect(settings.merge(settings.defaults(), { port: undefined }).port).toBeNull();
  expect(settings.read(file("null_port.json", JSON.stringify({ port: null })))).toEqual({
    settings: settings.defaults(),
    notices: [],
  });
});

test("voice.json lives in the state directory", () => {
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "/state";
  try {
    expect(settings.path()).toBe("/state/corgi/voice.json");
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
  }
});
