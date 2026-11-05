import { mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export const max_tricks = 16;
const max_directories = 128;
const max_depth = 8;
const ignored = new Set(["node_modules", "dist", "build", "coverage"]);
export function source(name: string): boolean {
  return /\.(?:[cm]?[jt]sx?|json|toml)$/i.test(name) && !name.startsWith(".");
}
export function folders(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort()
    .slice(0, max_tricks);
}
/** Bounded native watches. No polling, repository watches or dependency trees. */
export class Watcher {
  private watches = new Map<string, FSWatcher>();
  private pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private next = 0;
  private closed = false;
  private installed: string[] = [];
  error: string | null = null;
  constructor(
    readonly root: string,
    private changed: (names: Set<string>) => void,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.sync();
  }
  private folder(path: string): boolean {
    if (this.watches.has(path)) return true;
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
  private schedule(name: string) {
    if (this.closed) return;
    this.pending.add(name);
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        const names = this.pending;
        this.pending = new Set();
        this.next = Date.now() + 1000;
        this.sync();
        this.changed(names);
      },
      Math.max(250, this.next - Date.now()),
    ).unref();
  }
  sync() {
    if (this.closed) return;
    this.error = null;
    const wanted = new Set<string>();
    const visit = (path: string, name: string, depth: number) => {
      if (wanted.size >= max_directories || depth > max_depth) {
        this.error = "Autoreload watch limit reached; use Reload for deeper files.";
        return;
      }
      wanted.add(path);
      if (!this.watches.has(path)) {
        try {
          const watcher = watch(path, { persistent: false }, (event, file) => {
            const filename = file?.toString();
            if (!filename) {
              for (const installed of this.installed) this.schedule(installed);
            } else if (!name) {
              if (!filename.startsWith(".")) this.schedule(filename);
            } else if (
              source(filename) ||
              (event === "rename" &&
                !filename.startsWith(".") &&
                !ignored.has(filename) &&
                this.folder(join(path, filename)))
            ) {
              this.schedule(name);
            }
          });
          watcher.on("error", () => {
            this.error = "Autoreload watcher failed; use Reload to retry.";
            watcher.close();
            this.watches.delete(path);
          });
          this.watches.set(path, watcher);
        } catch {
          this.error = "Cannot watch trick files; use Reload to retry.";
        }
      }
      if (!name) return;
      try {
        for (const entry of readdirSync(path, { withFileTypes: true }))
          if (entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name))
            visit(join(path, entry.name), name, depth + 1);
      } catch {}
    };
    visit(this.root, "", 0);
    try {
      this.installed = folders(this.root);
    } catch {
      this.error = "Tricks folder is unavailable; use Reload to retry.";
      for (const installed of this.installed) this.schedule(installed);
      this.installed = [];
    }
    for (const name of this.installed) visit(join(this.root, name), name, 1);
    for (const [path, watcher] of this.watches)
      if (!wanted.has(path)) {
        watcher.close();
        this.watches.delete(path);
      }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
    for (const watcher of this.watches.values()) watcher.close();
    this.watches.clear();
  }
}
