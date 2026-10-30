//! Local rollout identity when the shared app server does not own a thread.
import path from "node:path";
import { open } from "node:fs/promises";
import { Text, str } from "../common";
import { Path } from "../../bounded_text";
import { Snapshot, type Request } from "../snapshot";
import { titleSession } from "./index";

type Identity = { session: string; transcript: string; cwd: string };
export class Local {
  private cache = new Map<string, { at: number; identity: Identity | null }>();
  constructor(readonly directory: string) {}
  async read(request: Request): Promise<Snapshot | null> {
    const prefix = request.prefix.text();
    if (titleSession(prefix.length === 29 ? prefix + "..." : prefix)?.text() !== prefix) return null;
    let cached = this.cache.get(prefix);
    if (!cached || Date.now() - cached.at >= 5000) {
      cached = { at: Date.now(), identity: await this.find(prefix) };
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(prefix, cached);
    }
    const identity = cached.identity;
    if (!identity) return null;
    const out = new Snapshot(request, identity.session, "unknown");
    out.lifecycle = false;
    out.transcript = Path.init(identity.transcript);
    if (path.isAbsolute(identity.cwd)) out.cwd = Path.init(identity.cwd);
    return out;
  }
  private async find(prefix: string): Promise<Identity | null> {
    let found: Identity | null = null;
    const files = new Bun.Glob(`**/rollout-*-${prefix}*.jsonl`);
    try {
      for await (const relative of files.scan({ cwd: path.join(this.directory, "sessions"), onlyFiles: true })) {
        const file = path.join(this.directory, "sessions", relative);
        const handle = await open(file);
        try {
          // Session headers include instructions, so allow a bounded large first line.
          const buffer = Buffer.alloc(4 * 1024 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const end = buffer.subarray(0, bytesRead).indexOf(10);
          if (end < 0) continue;
          const record = JSON.parse(buffer.subarray(0, end).toString());
          const session = str(record.payload, "id");
          if (
            record.type !== "session_meta" ||
            titleSession(session)?.len !== 36 ||
            !session.startsWith(prefix) ||
            record.payload?.ephemeral === true
          )
            continue;
          if (found && found.session !== session) return null;
          found = { session, transcript: file, cwd: str(record.payload, "cwd") };
        } finally {
          await handle.close();
        }
      }
    } catch {
      return null;
    }
    return found;
  }
}
