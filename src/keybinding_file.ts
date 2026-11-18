import { statSync } from "node:fs";

/** Calls `changed` when `file` changes, following the path even when an
 * editor replaces the file or its directory. */
export function observe(file: string, changed: () => void): () => void {
  const revision = () => {
    try {
      const s = statSync(file, { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : false;
    }
  };
  let previous = revision();
  const timer = setInterval(() => {
    const next = revision();
    if (next === previous) return;
    previous = next;
    changed();
  }, 200);
  timer.unref();
  return () => clearInterval(timer);
}
