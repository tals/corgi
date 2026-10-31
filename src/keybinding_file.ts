import { statSync } from "node:fs";
import * as preferences from "./preferences";

/** Follow the path even when an editor replaces the file or its directory. */
export function observe(file: string, changed: (value: preferences.Preferences | null) => void): () => void {
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
    changed(next === null ? new preferences.Preferences() : next === false ? null : preferences.readExisting(file));
  }, 200);
  timer.unref();
  return () => clearInterval(timer);
}
