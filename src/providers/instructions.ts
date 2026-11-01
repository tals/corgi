//! Instructions a provider reads from a file: off its command line, where
//! `ps` shows them, and out of saved state, which keeps only the path.
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const prefix = "corgi-instructions-";
/** Writes `text` where only this user can read it; the file's path. */
export function write(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), prefix)), "instructions.md");
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}
/** Removes a file `write` made, and its folder; anything else stays. */
export function remove(file: string) {
  const dir = dirname(file);
  if (basename(file) !== "instructions.md" || !basename(dir).startsWith(prefix) || dirname(dir) !== tmpdir()) return;
  try {
    rmSync(file, { force: true });
    rmdirSync(dir);
  } catch {}
}
