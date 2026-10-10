import { watch, readdirSync, statSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { Condition } from "./compat";
export type Root = { path: string; depth: number };
export class Changes {
  paths = new Set<string>();
  overflow = false;
  add(path: string) {
    this.paths.add(path);
  }
  clear() {
    this.paths.clear();
    this.overflow = false;
  }
  take(other: Changes) {
    for (const path of other.paths) this.add(path);
    this.overflow ||= other.overflow;
    other.clear();
  }
}
export class Watcher {
  private watches = new Map<string, FSWatcher>();
  private changes = new Changes();
  private wake = new Condition();
  private stopped = false;
  static init(roots: Root[], _latency_ms: number) {
    if (!["linux", "darwin"].includes(process.platform)) throw Error("Unsupported");
    return new Watcher(roots);
  }
  constructor(private roots: Root[]) {
    for (const root of roots) this.add(root.path, root.depth);
  }
  private add(path: string, depth: number) {
    if (this.stopped || this.watches.has(path)) return;
    try {
      const watcher = watch(path, (event, file) => {
        if (!file) {
          this.changes.overflow = true;
          this.wake.broadcast();
          return;
        }
        const changed = join(path, file.toString());
        this.changes.add(changed);
        if (event === "rename" && depth > 0)
          try {
            if (statSync(changed).isDirectory()) this.add(changed, depth - 1);
          } catch {}
        this.wake.broadcast();
      });
      watcher.on("error", () => {
        this.changes.overflow = true;
        this.wake.broadcast();
      });
      this.watches.set(path, watcher);
      if (depth > 0)
        for (const entry of readdirSync(path, { withFileTypes: true }))
          if (entry.isDirectory()) this.add(join(path, entry.name), depth - 1);
    } catch {
      this.changes.overflow = true;
    }
  }
  async wait(timeout_ms: number | null, out: Changes): Promise<void> {
    if (!this.changes.paths.size && !this.changes.overflow && !this.stopped)
      try {
        await this.wake.wait(timeout_ms ?? undefined);
      } catch {}
    out.take(this.changes);
  }
  interrupt() {
    this.wake.broadcast();
  }
  close() {
    this.stopped = true;
    for (const w of this.watches.values()) w.close();
    this.watches.clear();
    this.wake.broadcast();
  }
}
