import { openSync, closeSync, fstatSync, readFileSync, constants } from "node:fs";
import path from "node:path";
import { BoundedText } from "../../bounded_text";
import { nativeFiles } from "../../build_assets";
export class Name extends BoundedText(160) {}
import { Codex } from "./index";
import type { Agent } from "../../agents";
type IndexWorker = Worker & { unref(): void };
export class Index {
  names = new Map<string, Name>();
  next_read = 0;
  stamp = "";
  private worker: IndexWorker | null = null;
  private pending: Promise<void> | null = null;
  private complete: (() => void) | null = null;
  close() {
    this.worker?.terminate();
    this.worker = null;
    this.complete?.();
    this.complete = null;
    this.names.clear();
  }
  refresh() {
    this.refreshFile(path.join(Codex.info.configDir(), "session_index.jsonl"));
  }
  refreshFile(file: string) {
    const now = Date.now();
    if (now < this.next_read) return;
    this.next_read = now + 1000;
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return;
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (stamp === this.stamp) return;
      this.load(readFileSync(fd));
      this.stamp = stamp;
    } catch {
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  async refreshAsync() {
    if (this.pending) return this.pending;
    const now = Date.now();
    if (now < this.next_read) return;
    this.next_read = now + 1000;
    const pending = new Promise<void>(resolve => {
      this.complete = resolve;
    });
    this.pending = pending;
    try {
      if (!this.worker) {
        // A compiled bundle's import.meta.url belongs to the main entrypoint.
        const entry = nativeFiles ? "./providers/codex/files_worker.js" : "./files_worker.ts";
        this.worker = new Worker(new URL(entry, import.meta.url)) as IndexWorker;
        this.worker.onmessage = async event => {
          if (event.data.changed) {
            const names = new Map<string, Name>();
            const entries: Array<[string, string]> = event.data.entries;
            for (let at = 0; at < entries.length; at += 512) {
              for (const [id, name] of entries.slice(at, at + 512)) names.set(id, new Name(name));
              if (at + 512 < entries.length) await new Promise<void>(resolve => setImmediate(resolve));
            }
            if (this.worker) {
              this.names = names;
              this.stamp = event.data.stamp;
            }
          }
          this.complete?.();
        };
        this.worker.onerror = () => {
          this.worker?.terminate();
          this.worker = null;
          this.complete?.();
        };
        this.worker.unref();
      }
      this.worker.postMessage({
        path: path.join(Codex.info.configDir(), "session_index.jsonl"),
      });
      await pending;
    } finally {
      this.pending = null;
      this.complete = null;
    }
  }
  load(bytes: string | Uint8Array) {
    const names = new Map<string, Name>();
    const input = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let start = 0;
    for (let at = 0; at < input.length; at++) {
      if (input[at] !== 10) continue;
      try {
        const record = JSON.parse(decoder.decode(input.subarray(start, at)));
        if (typeof record.id === "string" && typeof record.thread_name === "string" && record.thread_name)
          names.set(record.id, Name.ascii(record.thread_name));
      } catch {}
      start = at + 1;
    }
    this.names = names;
  }
  name(session: string) {
    return this.names.get(session) ?? new Name();
  }
}
export function available(agent: Agent, now: number) {
  return agent.provider === "codex" && (!agent.metadata_at || now - agent.metadata_at > 5000000);
}
