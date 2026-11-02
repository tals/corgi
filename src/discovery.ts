import * as build_id from "./build_id";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { resolve as absolute } from "node:path";
import { Provider, adapter } from "./providers";
import { PathSearch } from "./os";
import { testBuild } from "./build_assets";
import * as subprocess from "./subprocess";
function executable(path: string): boolean {
  const self = build_id.executablePath(
    import.meta.filename,
    process.execPath,
    absolute(import.meta.dir, "../corgi"),
    process.env.CORGI_APP_EXE,
  );
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return false;
    accessSync(path, constants.X_OK);
    const real = realpathSync(path);
    return real !== realpathSync(self);
  } catch {
    return false;
  }
}
/** The executable `CORGI_<PROVIDER>_BIN` names in its place, if set. */
export function override(provider: Provider): string | undefined {
  return process.env[`CORGI_${provider.toUpperCase()}_BIN`];
}
function installs(provider: Provider) {
  return adapter(provider).installs({
    home: process.env.HOME || null,
    root: testBuild ? (process.env.CORGI_TEST_SYSTEM_ROOT ?? "") : "",
  });
}
/** What each candidate's `--version` said, while its file stays as it was:
 * whether it was the provider's, and its version line. */
const verdicts = new Map<string, { stamp: string; ok: boolean; version: string }>();
function stamp(path: string): string | null {
  try {
    const s = statSync(realpathSync(path));
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}
function verdict(path: string) {
  const v = verdicts.get(path);
  return v && v.stamp === stamp(path) ? v : null;
}
/** The version line of an install `resolve` turned down, as when it is too
 * old, or null when none answered. */
export function outdated(provider: Provider): string | null {
  for (const candidate of candidates(provider)) {
    const v = verdict(candidate);
    if (v && !v.ok) return v.version;
  }
  return null;
}
/** Each install found for `provider`, with what its `--version` said when
 * `resolve` asked: its version line and whether it was taken, or null for
 * one it never asked. */
export function considered(provider: Provider): { path: string; version: string | null; ok: boolean | null }[] {
  return candidates(provider).map(path => {
    const v = verdict(path);
    return { path, version: v?.version ?? null, ok: v?.ok ?? null };
  });
}
function candidates(provider: Provider): string[] {
  const command = adapter(provider).command,
    path = (process.env.PATH ?? "").split(":").map(dir => absolute(dir, command));
  return [...new Set([...path, ...installs(provider)])].filter(executable);
}
/** The promise's value if it settles within `ms`, else null. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => (timer = setTimeout(resolve, ms, null)));
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
export async function resolve(provider: Provider, cwd: string | null = null): Promise<string> {
  const { command, version } = adapter(provider),
    set = override(provider);
  if (set !== undefined && (set.length || !version)) return set;
  if (!version) return command;
  const deadline = performance.now() + 2000,
    path = (process.env.PATH ?? "").split(":").map(dir => absolute(cwd ?? process.cwd(), dir, command)),
    quit = subprocess.Quit.init(),
    probes: Promise<string | null>[] = [];
  let report!: (path: string) => void;
  const found = new Promise<string>(resolve => (report = resolve));
  const probe = async (candidate: string, timeout_ms: number) => {
    try {
      const at = stamp(candidate),
        output = await subprocess.run([candidate, "--version"], { timeout_ms, max_output: 4096, quit });
      if (!output.ok()) return null;
      const stdout = output.stdout.toString(),
        ok = version(stdout);
      if (at) verdicts.set(candidate, { stamp: at, ok, version: stdout.trim().split("\n")[0] });
      if (ok) {
        report(candidate);
        return candidate;
      }
    } catch {}
    return null;
  };
  try {
    for (const candidate of new Set([...path, ...installs(provider)])) {
      if (!executable(candidate)) continue;
      const known = verdict(candidate);
      if (known && probes.length === 0) {
        if (known.ok) return candidate;
        continue;
      }
      const left = deadline - performance.now();
      if (left <= 0) break;
      // A probe may use the whole budget, but after 750 ms the next
      // candidate starts beside it: a hung one shouldn't hide the rest.
      const running = probe(candidate, left);
      probes.push(running);
      const winner = await within(Promise.race([found, running]), Math.min(750, left));
      if (winner) return winner;
    }
    const rest = Promise.all(probes).then(paths => paths.find(path => path !== null) ?? null);
    const winner = await Promise.race([found, rest]);
    if (winner) return winner;
  } finally {
    quit.signal();
  }
  throw Error(outdated(provider) === null ? "ProviderNotFound" : "ProviderTooOld");
}
/** The first executable `name` on PATH that isn't Corgi itself: a pane-local
 * alias would otherwise exec Corgi again. */
export function onPath(name: string, path_list = process.env.PATH ?? ""): string | null {
  const search = PathSearch.init(path_list, name);
  for (let path = search.next(); path !== null; path = search.next()) if (executable(path)) return path;
  return null;
}
/** Whether the provider is there, short of an install whose `--version`
 * `resolve` turned down. */
export function installed(provider: Provider): boolean {
  const set = override(provider);
  if (set) return set.includes("/") ? executable(set) : onPath(set) !== null;
  if (!adapter(provider).version)
    return onPath(adapter(provider).command) !== null || installs(provider).some(executable);
  return candidates(provider).some(candidate => verdict(candidate)?.ok !== false);
}
/** Asks each provider with a version check which install is its own, so
 * `installed` leaves out what is too old. */
export async function check(): Promise<void> {
  await Promise.all(
    Provider.all.filter(p => adapter(p).version && override(p) === undefined).map(p => resolve(p).catch(() => {})),
  );
}
