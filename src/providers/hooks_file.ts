//! The hooks settings file Claude Code and Codex both read:
//! `{hooks: {Event: [{matcher?, hooks: [{type: "command", command}]}]}}`.
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { flock } from "../native_bridge";
import { atomicWrite, linkTarget, replaceable } from "../os";
import type { IntegrationStepResult } from "./adapter";
/** The handler Corgi adds: it reports only from panes Corgi runs. */
export function command(id: string): string {
  return (
    'if [ -n "${CORGI_PANE:-}" ] && [ -n "${CORGI_SOCKET:-}" ] && [ -x "${CORGI_BIN:-}" ]; then "$CORGI_BIN" hook ' +
    id +
    "; fi"
  );
}
/** A handler pasted from what the removed `corgi hooks` printed, which named
 * Corgi's executable instead. */
function pasted(handler: unknown, id: string): boolean {
  return typeof handler === "string" && /^'[^']*\/corgi' hook ([\w-]+)$/.exec(handler)?.[1] === id;
}
/** Whether `handler` runs Corgi's hook for provider `id`. */
function ours(handler: unknown, id: string): boolean {
  return handler === command(id) || pasted(handler, id);
}
/** The name Claude's and Codex's /hooks list Corgi's handlers by. */
const hook_name = "Reporting to Corgi";
function handlers(events: readonly string[], command: string) {
  const handler = { type: "command", command, timeout: 2, statusMessage: hook_name };
  return { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [handler] }]])) };
}
/** `existing` with Corgi's handler for provider `id` on every event in
 * `events`, or null if it already is. */
export function merged(existing: string, events: readonly string[], id: string): string | null {
  const handler = command(id),
    root = JSON.parse(existing),
    bad = () => {
      throw Error("InvalidHookSettings");
    };
  if (!root || typeof root !== "object" || Array.isArray(root)) bad();
  root.hooks ??= {};
  if (!root.hooks || typeof root.hooks !== "object" || Array.isArray(root.hooks)) bad();
  let changed = false;
  for (const [event, template] of Object.entries(handlers(events, handler).hooks)) {
    let groups = (root.hooks[event] ??= []);
    if (!Array.isArray(groups)) bad();
    for (const group of groups) if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) bad();
    // By command alone: Codex's approval covers the name, so renaming a
    // handler installed before it had one would stop it running.
    let found = groups.some((group: any) => group.hooks.some((h: any) => h?.command === handler));
    // A pasted handler becomes Corgi's in place, or goes if Corgi's is there,
    // with a group that only held it.
    groups = root.hooks[event] = groups.flatMap((group: any) => {
      const hooks = group.hooks.filter((h: any) => {
        if (!pasted(h?.command, id)) return true;
        changed = true;
        if (found) return false;
        h.command = handler;
        return (found = true);
      });
      return hooks.length || !group.hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!found) {
      groups.push(template[0]);
      changed = true;
    }
  }
  return changed ? JSON.stringify(root, null, 2) : null;
}
export type Position = { event: string; group: number; handler: number };
/** Hook settings without Corgi's handlers: the new text, the handlers
 * removed, and where each other handler moved from and to. */
export type Removal = { text: string; removed: Position[]; moved: [Position, Position][] };
export function removed(existing: string, id: string): Removal | null {
  const root = JSON.parse(existing);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw Error("InvalidHookSettings");
  const hooks = root.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const removed: Position[] = [],
    moved: [Position, Position][] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: any[] = [];
    groups.forEach((group, g) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return void kept.push(group);
      const handlers: any[] = [];
      group.hooks.forEach((handler: any, h: number) => {
        const from = { event, group: g, handler: h };
        if (ours(handler?.command, id)) removed.push(from);
        else moved.push([from, { event, group: kept.length, handler: handlers.push(handler) - 1 }]);
      });
      if (handlers.length) kept.push(handlers.length === group.hooks.length ? group : { ...group, hooks: handlers });
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!removed.length) return null;
  if (!Object.keys(hooks).length) delete root.hooks;
  return { text: JSON.stringify(root, null, 2), removed, moved };
}
/** How many of `events` run Corgi's handler for provider `id`, and how many
 * there are. */
export function counted(text: string, events: readonly string[], id: string): [number, number] {
  const hooks = JSON.parse(text)?.hooks,
    has = (groups: unknown) =>
      Array.isArray(groups) &&
      groups.some(group => Array.isArray(group?.hooks) && group.hooks.some((h: any) => ours(h?.command, id)));
  return [events.filter(event => has(hooks?.[event])).length, events.length];
}
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function failed(item: string, path: string, error: unknown): IntegrationStepResult {
  return { item, path, outcome: "failed", error: message(error) };
}
/** Deletes `path`; false if it wasn't there. */
export function remove(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function read(path: string) {
  let stat = null;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stat && !stat.isFile()) throw Error("HookSettingsNotRegular");
  if (stat && stat.size > 1024 * 1024) throw Error("FileTooBig");
  return { stat, before: stat ? readFileSync(path, "utf8") : "{}" };
}
/** `shared`, the default account's settings file, when `path` links to it,
 * as an account folder shares the default's: Corgi edits that one in place
 * of the link. */
function linked(path: string, shared: string | null): string {
  if (shared === null) return path;
  const real = (file: string) => {
    try {
      return join(realpathSync(dirname(file)), basename(file));
    } catch {
      return file;
    }
  };
  try {
    return real(resolve(dirname(path), readlinkSync(path))) === real(shared) ? shared : path;
  } catch {
    return path;
  }
}
/** A provider's hooks file: `name` in its settings `directory`, with
 * Corgi's handler for provider `id` on `events`. For an account besides the
 * default, `shares` is the default's folder, whose file a link may share. */
export class File {
  readonly path: string;
  readonly command: string;
  constructor(
    readonly id: string,
    readonly directory: string,
    name: string,
    readonly events: readonly string[],
    shares: string | null = null,
  ) {
    this.path = linked(join(directory, name), shares === null ? null : join(shares, name));
    this.command = command(id);
  }
  /** Edits the file under Corgi's lock. `change` returns the new text, or
   * null to leave the file as it is. A file linked from dotfiles is edited
   * where it lives, and its backup and Corgi's lock stay beside the link. */
  private edit(change: (text: string) => string | null, backup: boolean) {
    if (!existsSync(this.directory)) return "no_config";
    const path = linkTarget(this.path);
    // Settings that need no change are left untouched, lock file and all.
    if (change(read(path).before) === null) return "unchanged";
    const lock = openSync(join(dirname(this.path), ".corgi-hooks.lock"), "a", 0o600);
    try {
      if (!flock(lock)) throw Error("HookSettingsBusy");
      const { stat, before } = read(path),
        after = change(before);
      if (after === null) return "unchanged";
      if (!replaceable(path)) throw Error("HookSettingsReadOnly");
      if (stat && backup)
        try {
          writeFileSync(this.path + ".corgi-backup", before, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      if (stat ? readFileSync(path, "utf8") !== before : existsSync(path)) throw Error("HookSettingsChanged");
      atomicWrite(path, after + "\n", stat ? stat.mode & 0o777 : 0o600, false);
      return "changed";
    } finally {
      flock(lock, false);
      closeSync(lock);
    }
  }
  install(): IntegrationStepResult {
    try {
      const edit = this.edit(text => merged(text, this.events, this.id), true);
      if (edit === "no_config") return { item: "hooks", outcome: "no_config", path: this.directory };
      return { item: "hooks", outcome: edit === "changed" ? "added" : "present", path: this.path };
    } catch (error) {
      return failed("hooks", this.path, error);
    }
  }
  /** Takes Corgi's handlers out; `removal` says where the user's moved. */
  uninstall(): { result: IntegrationStepResult; removal: Removal | null } {
    let removal: Removal | null = null;
    try {
      const edit = this.edit(text => (removal = removed(text, this.id))?.text ?? null, false);
      if (edit === "no_config")
        return { result: { item: "hooks", outcome: "no_config", path: this.directory }, removal };
      return {
        result: { item: "hooks", outcome: edit === "changed" ? "removed" : "absent", path: this.path },
        removal,
      };
    } catch (error) {
      return { result: failed("hooks", this.path, error), removal: null };
    }
  }
  /** How many of its events run Corgi's handler. */
  status(): IntegrationStepResult & { events?: [number, number] } {
    if (!existsSync(this.directory)) return { item: "hooks", outcome: "no_config", path: this.directory };
    try {
      const events = counted(existsSync(this.path) ? readFileSync(this.path, "utf8") : "{}", this.events, this.id);
      if (events[0] === events[1]) return { item: "hooks", outcome: "present", path: this.path, events };
      if (!events[0]) return { item: "hooks", outcome: "absent", path: this.path, events };
      return {
        item: "hooks",
        outcome: "partial",
        path: this.path,
        subject: `${events[0]} of ${events[1]} events`,
        events,
      };
    } catch (error) {
      return failed("hooks", this.path, error);
    }
  }
  /** Deletes `backups` and Corgi's lock once its handlers are out. */
  cleanup(backups: string[]): IntegrationStepResult[] {
    const results: IntegrationStepResult[] = [];
    for (const backup of backups)
      try {
        if (remove(backup)) results.push({ item: "backup", outcome: "removed", path: backup });
      } catch (error) {
        results.push(failed("backup", backup, error));
      }
    try {
      remove(join(dirname(this.path), ".corgi-hooks.lock"));
    } catch {}
    return results;
  }
}
