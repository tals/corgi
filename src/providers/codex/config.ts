import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Position, Removal } from "../../integration";
/** What Corgi writes when the title is unset. */
const unset_title = ["app-name", "thread-id", "activity", "project"];
export function titleItems(tui: any): string[] | null {
  if (tui !== null && tui !== undefined && (typeof tui !== "object" || Array.isArray(tui)))
    throw Error("InvalidTitleConfig");
  const title = tui?.terminal_title;
  if (title === null || title === undefined) return unset_title;
  if (!Array.isArray(title) || title.some(item => typeof item !== "string")) throw Error("InvalidTitleConfig");
  return title.includes("thread-id") ? null : [...title, "thread-id"];
}
/** The title setting without the thread ID Corgi added: `undefined` leaves it
 * alone, `null` unsets it. `original` is the backup's config, when there is one. */
export function restoredTitle(title: unknown, original: any): string[] | null | undefined {
  if (!Array.isArray(title) || !title.includes("thread-id")) return undefined;
  if (original) {
    let added: string[] | null;
    try {
      added = titleItems(original.tui);
    } catch {
      added = [];
    }
    if (added === null) return undefined;
    if (isDeepStrictEqual(title, added)) return original.tui?.terminal_title ?? null;
  }
  if (isDeepStrictEqual(title, unset_title)) return null;
  return title.filter(item => item !== "thread-id");
}
/** The user layer for `path` in a `config/read` reply. */
export function userLayer(result: any, path: string): any {
  if (!Array.isArray(result?.layers)) throw Error("MissingConfigLayers");
  for (const layer of result.layers) {
    const source = layer.name;
    if (source?.type !== "user" || source.file !== path || source.profile != null) continue;
    if (layer.disabledReason != null) throw Error("DisabledConfigLayer");
    if (typeof layer.version !== "string" || !layer.version) throw Error("MissingConfigVersion");
    return layer;
  }
  throw Error("MissingUserConfig");
}
export function edit(result: any, path: string): any {
  const layer = userLayer(result, path),
    value = titleItems(layer.config?.tui);
  return value
    ? {
        keyPath: "tui.terminal_title",
        value,
        mergeStrategy: "replace",
        filePath: path,
        expectedVersion: layer.version,
      }
    : null;
}
/** Codex keeps hook approvals by position, as `file:event:group:handler`.
 * The approvals once Corgi's handlers are gone: theirs dropped, every other
 * handler's moved to its new position. Null when nothing changes. */
export function movedApprovals(
  state: Record<string, unknown>,
  file: string,
  removal: Removal,
): { state: Record<string, unknown>; moved: number } | null {
  const key = (p: Position) =>
      `${file}:${p.event.replace(/(?<=[a-z])(?=[A-Z])/g, "_").toLowerCase()}:${p.group}:${p.handler}`,
    next = { ...state };
  for (const p of [...removal.removed, ...removal.moved.flat()]) delete next[key(p)];
  let moved = 0;
  for (const [from, to] of removal.moved)
    if (Object.hasOwn(state, key(from))) {
      next[key(to)] = state[key(from)];
      if (key(from) !== key(to)) moved++;
    }
  return isDeepStrictEqual(next, state) ? null : { state: next, moved };
}
export function backup(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) throw Error("ConfigNotRegular");
  if (stat.size > 1024 * 1024) throw Error("FileTooBig");
  try {
    writeFileSync(path + ".corgi-backup", readFileSync(path), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
