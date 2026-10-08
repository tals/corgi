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
async function playEmbedded(kind: "done" | "request") {
  const path = join(tmpdir(), `corgi-sound-${crypto.randomUUID()}.mp3`);
  try {
    writeFileSync(path, readFileSync(kind === "request" ? request : done), { flag: "wx", mode: 0o600 });
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
