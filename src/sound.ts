import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import done from "../assets/sounds/done.mp3" with { type: "file" };
import request from "../assets/sounds/request.mp3" with { type: "file" };
import { run } from "./subprocess";
export async function runPlayer(argv: string[], timeout_ns: number | bigint): Promise<boolean> {
  try {
    return (await run(argv, { timeout_ms: Number(timeout_ns) / 1_000_000, max_output: 0 })).ok();
  } catch {
    return false;
  }
}
/** Corgi's own sound, set apart from the agents': a short rising yip, two
 * notes for an answer and three, higher, when it needs you. A 16-bit mono WAV. */
export function yip(needs_input: boolean): Buffer {
  const rate = 22_050,
    notes = needs_input ? [988, 1319, 1568] : [784, 1175],
    note = Math.floor(rate * 0.07),
    gap = Math.floor(rate * 0.025),
    count = notes.length * (note + gap),
    out = Buffer.alloc(44 + count * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + count * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(count * 2, 40);
  notes.forEach((hz, n) => {
    for (let i = 0; i < note; i++) {
      // A quick rise and a softer fall, so each note chirps rather than clicks.
      const t = i / note,
        envelope = Math.min(1, t * 12) * (1 - t) ** 2,
        sample = Math.sin((2 * Math.PI * hz * i) / rate) * envelope * 0.35;
      out.writeInt16LE(Math.round(sample * 32767), 44 + (n * (note + gap) + i) * 2);
    }
  });
  return out;
}
async function playEmbedded(kind: "done" | "request" | "corgi_done" | "corgi_request") {
  const corgi = kind.startsWith("corgi_"),
    path = join(tmpdir(), `corgi-sound-${crypto.randomUUID()}.${corgi ? "wav" : "mp3"}`);
  try {
    const data = corgi ? yip(kind === "corgi_request") : readFileSync(kind === "request" ? request : done);
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
    const players =
      process.platform === "darwin"
        ? [["afplay", path]]
        : [
            ["paplay", path],
            ["pw-play", path],
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path],
            ["mpg123", "-q", path],
            ["mpv", "--no-video", "--really-quiet", path],
          ];
    for (const argv of players) if (await runPlayer(argv, 15_000_000_000)) return;
    throw Error("NoAudioPlayer");
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}
export function play(kind: string): void {
  const setting = process.env.CORGI_BELL;
  if (setting === "off") return;
  const bell = () => process.stdout.write("\x07");
  if (setting === "terminal" || process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined) {
    bell();
    return;
  }
  void playEmbedded(kind === "needs_input" ? "request" : "done").catch(bell);
}
/** Corgi's own sound, for the prompt put away: it answered, or needs you. */
export function playCorgi(needs_input: boolean): void {
  const setting = process.env.CORGI_BELL;
  if (setting === "off") return;
  const bell = () => process.stdout.write("\x07");
  if (setting === "terminal" || process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined) {
    bell();
    return;
  }
  void playEmbedded(needs_input ? "corgi_request" : "corgi_done").catch(bell);
}
