/** Writes the raw s16le 16 kHz mono PCM fixtures the voice tests stream
 * through the fake ffmpeg: `bun tests/fixtures/voice/make_pcm.ts`. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const rate = 16000;

/** `seconds` of a 300 Hz tone at RMS `level` (full scale is 1). */
export function tone(seconds: number, level = 0.1): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate)),
    peak = level * Math.SQRT2 * 32768;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(peak * Math.sin((2 * Math.PI * 300 * i) / rate));
  return out;
}
export function silence(seconds: number): Int16Array {
  return new Int16Array(Math.round(seconds * rate));
}
/** Uniform noise at RMS `level`, from a fixed seed so the files never change. */
export function noise(seconds: number, level = 0.003): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate)),
    peak = level * Math.sqrt(3) * 32768;
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out[i] = Math.round((seed / 0xffffffff) * 2 * peak - peak);
  }
  return out;
}
/** `seconds` of music that never pauses, from `seed`: a soft drone under a
 * note every quarter second, louder or softer by its place in the bar, with a
 * click every half second; each bar varies a little, as a song's do. */
export function music(seconds: number, seed = 1): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate)),
    note = rate / 4,
    click = 0.04 * rate,
    accents = [1, 0.5, 0.7, 0.5, 0.85, 0.5, 0.7, 0.5],
    scale = [220, 247, 277, 330, 370, 440, 494, 554, 660];
  let state = seed >>> 0 || 1;
  const random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 0x100000000;
  let pitch = 0,
    gain = 0,
    beat = 0;
  for (let i = 0; i < out.length; i++) {
    const k = i % note;
    if (k === 0) {
      const n = i / note;
      pitch = scale[Math.floor(random() * scale.length)];
      gain = 0.06 * accents[n % 8] * (0.95 + 0.1 * random());
      beat = n % 2 ? 0 : 0.12 * (0.95 + 0.1 * random());
    }
    const drone = 0.01 * Math.sin((2 * Math.PI * 110 * i) / rate),
      tone = gain * (1 - (0.5 * k) / note) * Math.sin((2 * Math.PI * pitch * k) / rate),
      noise = k < click ? beat * Math.sqrt(3) * (2 * random() - 1) : 0;
    out[i] = Math.round((Math.SQRT2 * (drone + tone) + noise) * 32768);
  }
  return out;
}
export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export const shapes = {
  speech: () => concat(tone(1.5), silence(3)),
  noise: () => concat(noise(10), silence(3)),
  long: () => tone(35),
  two: () => concat(tone(1.5), silence(3), tone(1.5), silence(3)),
};

// `long` is built in memory by the tests that need it.
if (import.meta.main)
  for (const [name, make] of Object.entries(shapes).filter(([name]) => name !== "long")) {
    const pcm = make();
    writeFileSync(join(import.meta.dir, `${name}.pcm`), new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  }
