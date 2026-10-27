//! The Whisper models and the speech filter voice mode can use, pinned by
//! size and SHA-256, and where they are cached.
import { statSync } from "node:fs";
import { join } from "node:path";

export type ModelName = "tiny.en" | "base.en" | "small.en" | "medium" | "large-v3-turbo";
export type Entry = { name: ModelName | "filter"; file: string; url: string; bytes: number; sha256: string };

const whisper = (name: ModelName, bytes: number, sha256: string): Entry => ({
  name,
  file: `ggml-${name}.bin`,
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`,
  bytes,
  sha256,
});
// Hashes are the `lfs.oid` of each file in the Hugging Face tree API.
export const catalog: Record<ModelName, Entry> = {
  "tiny.en": whisper("tiny.en", 77_704_715, "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f"),
  "base.en": whisper("base.en", 147_964_211, "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"),
  "small.en": whisper("small.en", 487_614_201, "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d"),
  medium: whisper("medium", 1_533_763_059, "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208"),
  "large-v3-turbo": whisper(
    "large-v3-turbo",
    1_624_555_275,
    "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
  ),
};
/** Silero VAD for whisper-server's `--vad`. */
export const filter: Entry = {
  name: "filter",
  file: "ggml-silero-v6.2.0.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  bytes: 885_098,
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
};
export const names = Object.keys(catalog) as ModelName[];
export const default_model: ModelName = "base.en";

export function parseName(s: string): ModelName | null {
  return (names as string[]).includes(s) ? (s as ModelName) : null;
}
export function cacheDir(): string {
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "corgi", "voice");
  if (!process.env.HOME) throw Error("NoHome");
  return join(process.env.HOME, ".cache", "corgi", "voice");
}
export function fileOf(entry: Entry): string {
  return join(cacheDir(), entry.file);
}
/** Present with exactly the pinned size; the hash was checked on download. */
export function installed(entry: Entry): boolean {
  try {
    return statSync(fileOf(entry)).size === entry.bytes;
  } catch {
    return false;
  }
}
