import { watch, mkdirSync, existsSync } from "node:fs";
import { dirname, basename } from "node:path";
import * as preferences from "./preferences";

/** Watch the directory so editor renames and our atomic writes keep working. */
export function observe(file: string, changed: (value: preferences.Preferences | null) => void): () => void {
  mkdirSync(dirname(file), { recursive: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
    if (name !== null && String(name) !== basename(file)) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      changed(existsSync(file) ? preferences.readExisting(file) : new preferences.Preferences());
    }, 60);
    timer.unref();
  });
  watcher.on("error", () => changed(null));
  return () => {
    watcher.close();
    if (timer !== null) clearTimeout(timer);
  };
}
