/**
 * Records a ghostty-host's frames losslessly at a steady rate, for
 * ghostty_video.ts. Each tick holds the latest frame Ghostty drew before it,
 * so the recording's frame k is the screen at start + k / FPS:
 *
 *   bun tools/ghostty_record.ts SOCKET FPS OUT.mkv
 *
 * Prints {"start": ms since the epoch} once its first frame is written. On
 * SIGINT it takes the frames Ghostty drew before then that are still on their
 * way, fills the ticks up to then, closes the file and exits.
 */
import type { FileSink } from "bun";
import * as ghostty_host from "./ghostty_host";

/** How late a frame may arrive and still land on its own tick. */
const LATENESS = 100;
/** How long a stop waits for frames drawn before it, when none drawn after it arrives first. */
const FLUSH = 150;

const [socket, rate, out] = process.argv.slice(2);
const fps = Number(rate);
if (!socket || !out || !Number.isInteger(fps) || fps < 1 || fps > 120) {
  console.error("usage: ghostty_record.ts SOCKET FPS OUT.mkv");
  process.exit(2);
}
const host = new ghostty_host.Host(socket);
const stopping = new AbortController();
let stopAt: number | null = null;
process.on("SIGINT", () => {
  if (stopAt !== null) return;
  stopAt = Date.now();
  // A frame drawn after the stop ends the stream sooner; an idle screen draws none.
  setTimeout(() => stopping.abort(), FLUSH);
});

/** A frame's pixels without row padding. */
function pack(pixels: Uint8Array, width: number, height: number, stride: number): Uint8Array {
  if (stride === width * 4) return pixels;
  const packed = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) packed.set(pixels.subarray(y * stride, y * stride + width * 4), y * width * 4);
  return packed;
}

// The screen as it is now, which may have been drawn long before.
const first = await host.request("GET", "/frame");
if (!first.ok) throw Error(`ghostty-host /frame: ${first.status}`);
const header = (name: string) => Number(first.headers.get(`x-frame-${name}`));
const [width, height] = [header("width"), header("height")];
let current = pack(new Uint8Array(await first.arrayBuffer()), width, height, header("stride"));
const seq = first.headers.get("x-frame-seq") ?? "0";

const ffmpeg = Bun.spawn(
  [
    ...["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", String(fps)],
    ...["-i", "pipe:0", "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", out],
  ],
  { stdin: "pipe", stdout: "ignore", stderr: "inherit" },
);
const sink = ffmpeg.stdin as FileSink;
const start = Date.now();
let ticks = 0;

/** Writes the current frame for every tick before (or, with through, at) t. */
async function fill(t: number, through = false) {
  while (through ? start + (ticks * 1000) / fps <= t : start + (ticks * 1000) / fps < t) {
    sink.write(current);
    ticks++;
    await sink.flush();
  }
}

// Ticks and frames take turns, so each tick is written once, in order.
let turn: Promise<unknown> = Promise.resolve();
const queue = (work: () => Promise<unknown>) => (turn = turn.then(work));

await fill(start, true);
console.log(JSON.stringify({ start }));
// An idle screen draws nothing; ticks still go out while it holds.
const idle = setInterval(() => queue(() => fill(Math.min(Date.now() - LATENESS, stopAt ?? Infinity), true)), LATENESS);

try {
  const stream = await host.request("GET", `/frames?after=${seq}`, undefined, stopping.signal);
  const reader = stream.body!.getReader();
  const head = new Uint8Array(ghostty_host.FRAME_HEADER);
  let [have, got] = [0, 0];
  let frame: ghostty_host.FrameHeader | null = null;
  let pixels = new Uint8Array(0);
  stream: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length;) {
      if (!frame) {
        const n = Math.min(head.length - have, value.length - i);
        head.set(value.subarray(i, i + n), have);
        [have, i] = [have + n, i + n];
        if (have < head.length) continue;
        frame = ghostty_host.frameHeader(head);
        if (!frame) throw Error("ghostty-host sent something other than a GCF1 frame");
        [pixels, have, got] = [new Uint8Array(frame.bytes), 0, 0];
        continue;
      }
      const n = Math.min(frame.bytes - got, value.length - i);
      pixels.set(value.subarray(i, i + n), got);
      [got, i] = [got + n, i + n];
      if (got < frame.bytes) continue;
      const done = frame;
      frame = null;
      // Drawn after the stop: everything before it is in.
      if (stopAt !== null && done.time > stopAt) {
        stopping.abort();
        break stream;
      }
      // A frame of another size can't go into this recording.
      if (done.width !== width || done.height !== height) continue;
      const next = pack(pixels, width, height, done.stride);
      // Waiting here holds the stream back; the host drops frames for a reader that falls behind.
      await queue(async () => {
        await fill(done.time);
        current = next;
      });
    }
  }
} catch (error) {
  if (!stopping.signal.aborted) {
    console.error(`ghostty_record: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
clearInterval(idle);
await queue(() => fill(stopAt ?? Date.now(), true));
await sink.end();
const code = await ffmpeg.exited;
process.exit(code || (process.exitCode as number) || 0);
