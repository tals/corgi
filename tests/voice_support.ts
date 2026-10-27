/** Fakes and helpers for the voice suites: fake ffmpeg, whisper-server and
 * ssh first on PATH, model files in the runtime's cache, and a voice client. */
import { closeSync, ftruncateSync, mkdirSync, openSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXE, ROOT, quote, writeExecutable } from "./support";
import { LocalLink } from "../src/voice/link";
import * as models from "../src/voice/models";
import type { Runtime } from "./runtime";

export const FIXTURES = join(ROOT, "tests/fixtures/voice");

/** Points `t`'s environment at the voice fakes and installs base.en and the
 * filter, once: a test may remove a file before voice mode starts. */
export function voiceEnv(t: Runtime) {
  if (t.env.CORGI_VOICE_SSH) return t.env;
  const bin = join(t.temp.name, "voice-bin");
  mkdirSync(bin, { recursive: true });
  // The bridge runs `corgi` on the "remote" host, which is this one.
  symlinkSync(EXE, join(bin, "corgi"));
  t.env.PATH = [FIXTURES, bin, dirname(process.execPath), t.env.PATH ?? process.env.PATH].join(":");
  t.env.XDG_CACHE_HOME = join(t.temp.name, ".cache");
  t.env.CORGI_VOICE_SSH = join(FIXTURES, "ssh");
  for (const entry of [models.catalog["base.en"], models.filter]) install(t, entry);
  return t.env;
}
/** A model file of the pinned size; sparse, so it costs no disk. */
export function install(t: Runtime, entry: models.Entry) {
  const file = modelFile(t, entry);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "w");
  try {
    ftruncateSync(fd, entry.bytes);
  } finally {
    closeSync(fd);
  }
}
export function modelFile(t: Runtime, entry: models.Entry) {
  return join(t.env.XDG_CACHE_HOME!, "corgi", "voice", entry.file);
}
/** A pane program that records the raw bytes it reads, in raw mode, after
 * turning on bracketed paste or the kitty keyboard protocol when asked. */
export function capture(t: Runtime, name: string, modes = "") {
  const program = join(t.temp.name, "capture.ts"),
    file = join(t.temp.name, `${name}.bin`);
  writeExecutable(
    program,
    `#!/usr/bin/env bun
import { openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
process.stdout.write(process.argv[3] + 'READY');
const fd = openSync(process.argv[2], 'w');
process.stdin.on('data', data => writeSync(fd, data));
process.stdin.resume();
`,
  );
  return { command: [process.execPath, program, file, modes].map(quote).join(" "), file };
}
export const bracketed = "\x1b[?2004h",
  kitty = "\x1b[>9u";

/** A voice client on the runtime's socket, as voice mode connects. */
export async function voiceClient(t: Runtime, opts: { heartbeat_ms?: number } = {}) {
  const link = await LocalLink.connect(t.path, opts);
  t.addCleanup(() => link.close());
  return link;
}
