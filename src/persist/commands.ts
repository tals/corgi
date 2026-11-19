//! Older readers have 2 KiB command slots. Keep longer commands in durable files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Tokens } from "../launch/tokens";
import * as command from "../launch/command";
import * as os from "../os";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function exportCommand(value: string | null): string | null {
  if (value === null || Buffer.byteLength(value) <= 2048) return value;
  const root = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/", ".local", "state"),
    file = join(root, "corgi", "resume-commands", digest(value) + ".sh"),
    contents = value + "\n";
  let saved = "";
  try {
    saved = readFileSync(file, "utf8");
  } catch {}
  if (saved !== contents) os.atomicWrite(file, contents);
  return os.shellWords([basename(command.shell()) === "fish" ? "source" : ".", file]);
}

export function importCommand(value: string | null): string | null {
  if (value === null) return null;
  const tokens = new Tokens(value),
    op = tokens.next(),
    file = tokens.next();
  if ((op !== "." && op !== "source") || !file || value !== os.shellWords([op, file])) return value;
  const hash = /\/corgi\/resume-commands\/([a-f0-9]{64})\.sh$/.exec(file)?.[1];
  if (!hash) return value;
  try {
    const contents = readFileSync(file, "utf8"),
      original = contents.slice(0, -1);
    if (contents.endsWith("\n") && digest(original) === hash) return original;
  } catch {}
  return value;
}
