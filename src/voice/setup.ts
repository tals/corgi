//! `corgi voice setup`: checks the tools voice mode runs, downloads the
//! speech model and the speech filter, and says whether voice is ready.
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import * as models from "./models";
import * as discovery from "../discovery";
import * as subprocess from "../subprocess";
import * as errors from "../errors";

export type Tool = "whisper-server" | "ffmpeg";

/** The platform's family, from /etc/os-release on Linux. */
function family(): "macos" | "arch" | "debian" | "linux" {
  if (process.platform === "darwin") return "macos";
  try {
    const ids = [...readFileSync("/etc/os-release", "utf8").matchAll(/^ID(?:_LIKE)?=(.*)$/gm)].map(m => m[1]).join(" ");
    if (/\barch\b/.test(ids)) return "arch";
    if (/\b(debian|ubuntu)\b/.test(ids)) return "debian";
  } catch {}
  return "linux";
}
/** How to install `tool` here. */
export function hint(tool: Tool, platform = family()): string {
  switch (platform) {
    case "macos":
      return tool === "ffmpeg" ? "brew install ffmpeg" : "brew install whisper-cpp";
    case "arch":
      return tool === "ffmpeg" ? "sudo pacman -S ffmpeg" : "sudo pacman -S whisper-cpp";
    case "debian":
      return tool === "ffmpeg" ? "sudo apt install ffmpeg" : "sudo apt install whisper.cpp-tools";
    case "linux":
      return tool === "ffmpeg"
        ? "install ffmpeg with your package manager"
        : "build whisper.cpp from source with CMake (build/bin/whisper-server)";
  }
}
/** Whether this whisper-server knows `--vad`, which the speech filter needs. */
async function hasVad(binary: string): Promise<boolean> {
  try {
    const out = await subprocess.run([binary, "--help"], { timeout_ms: 5000, stderr: true, env: process.env });
    return /--vad\b/.test(out.stdout.toString() + out.stderr.toString());
  } catch {
    return false;
  }
}
/** Downloads `entry` to the cache through `<file>.part`, checking its size
 * and SHA-256 before it takes the file's name. */
export async function download(entry: models.Entry, progress: (bytes: number) => void): Promise<void> {
  const file = models.fileOf(entry),
    part = file + ".part";
  mkdirSync(dirname(file), { recursive: true });
  try {
    const reply = await fetch(entry.url);
    if (!reply.ok || !reply.body) throw Error("DownloadFailed");
    const hash = createHash("sha256");
    let bytes = 0;
    // The pipeline fails on a write error too (a full disk), and closes the file either way.
    await pipeline(
      reply.body,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          bytes += chunk.length;
          if (bytes > entry.bytes) throw Error("ChecksumMismatch");
          progress(bytes);
          yield chunk;
        }
      },
      createWriteStream(part, { mode: 0o644 }),
    );
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) throw Error("ChecksumMismatch");
    renameSync(part, file);
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
}
const mb = (bytes: number) => (bytes / 1e6).toFixed(1) + " MB";

/** Prints the readiness report; 0 when voice is ready, 1 otherwise. */
export async function run(
  opts: { model: models.ModelName },
  deps: {
    write?: (text: string) => void;
    entries?: { model: models.Entry; filter: models.Entry };
    path?: string;
  } = {},
): Promise<number> {
  const write = deps.write ?? (text => void process.stdout.write(text)),
    entries = deps.entries ?? { model: models.catalog[opts.model], filter: models.filter },
    path = deps.path ?? process.env.PATH ?? "";
  let ready = true;
  const whisper = discovery.onPath("whisper-server", path);
  if (!whisper) {
    ready = false;
    write(`[missing] whisper-server: install with ${hint("whisper-server")}\n`);
  } else if (!(await hasVad(whisper))) {
    ready = false;
    write(`[too old] whisper-server at ${whisper} has no --vad; update it: ${hint("whisper-server")}\n`);
  } else write(`[ok] whisper-server ${whisper}\n`);
  const ffmpeg = discovery.onPath("ffmpeg", path);
  if (ffmpeg) write(`[ok] ffmpeg ${ffmpeg}\n`);
  else {
    ready = false;
    write(`[missing] ffmpeg: install with ${hint("ffmpeg")}\n`);
  }
  for (const [label, entry] of [
    [`model ${opts.model}`, entries.model],
    ["speech filter", entries.filter],
  ] as const) {
    if (models.installed(entry)) {
      write(`[ok] ${label} ${models.fileOf(entry)}\n`);
      continue;
    }
    let shown = "";
    try {
      await download(entry, bytes => {
        const line = `downloading ${label}  ${mb(bytes)} / ${mb(entry.bytes)}  ${Math.floor((bytes * 100) / entry.bytes)}%`;
        if (line !== shown) write(`\r\x1b[2K${(shown = line)}`);
      });
      write(`\r\x1b[2K[ok] ${label} ${models.fileOf(entry)}\n`);
    } catch (error) {
      ready = false;
      const why = errors.is(error, "ChecksumMismatch")
        ? "the download did not match its checksum"
        : "the download failed";
      write(`\r\x1b[2K[failed] ${label}: ${why}; run corgi voice setup again\n`);
    }
  }
  write(ready ? "Voice is ready: run corgi voice\n" : "Voice is not ready yet; see above.\n");
  return ready ? 0 : 1;
}
