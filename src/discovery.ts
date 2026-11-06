import * as build_id from "./build_id";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { resolve as absolute } from "node:path";
import { Provider, adapter } from "./providers";
import { PathSearch } from "./os";
import { testBuild } from "./build_assets";
import * as subprocess from "./subprocess";
import * as metadata from "./install_metadata";
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
/** Installation metadata, or a standalone binary's answer, while its files stay unchanged. */
const verdicts = new Map<
  string,
  { stamp: string; ok: boolean; version: string | null; file?: string; file_stamp?: string | null }
>();
const managed = new Map<string, string[]>();
function context(provider: Provider, cwd: string) {
  return [
    provider,
    cwd,
    process.env.PATH,
    process.env.HOME,
    process.env.MISE_DATA_DIR,
    process.env.MISE_CONFIG_DIR,
    process.env.XDG_DATA_HOME,
  ].join("\0");
}
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
  return v && v.stamp === stamp(path) && (!v.file || v.file_stamp === stamp(v.file)) ? v : null;
}
function remember(provider: Provider, path: string, version: string | null, file?: string) {
  const at = stamp(path);
  if (!at) return null;
  const v = {
    stamp: at,
    ok: version !== null && (adapter(provider).version?.(version) ?? true),
    version,
    ...(file ? { file, file_stamp: stamp(file) } : {}),
  };
  verdicts.set(path, v);
  return v;
}
function packaged(provider: Provider, path: string) {
  const distribution = adapter(provider).distribution,
    found = distribution && metadata.packageVersion(path, distribution.packages);
  return found && distribution ? remember(provider, path, distribution.version(found.version), found.file) : null;
}
/** The version line of an install `resolve` turned down, as when it is too
 * old, or null when none answered. */
export function outdated(provider: Provider, cwd = process.cwd()): string | null {
  for (const candidate of candidates(provider, cwd)) {
    const v = verdict(candidate);
    if (v && !v.ok && v.version !== null) return v.version;
  }
  return null;
}
/** Each real install, its known version and whether discovery accepted it. */
export function considered(
  provider: Provider,
  cwd = process.cwd(),
): { path: string; version: string | null; ok: boolean | null }[] {
  return candidates(provider, cwd).map(path => {
    const v = verdict(path);
    return { path, version: v?.version ?? null, ok: v?.ok ?? null };
  });
}
function commands(provider: Provider): string[] {
  const a = adapter(provider);
  return [...new Set([a.command, ...a.programs.names])];
}
function candidates(provider: Provider, cwd = process.cwd()): string[] {
  const path = (process.env.PATH ?? "")
    .split(":")
    .flatMap(dir => commands(provider).map(command => absolute(cwd, dir, command)));
  return [...new Set([...(managed.get(context(provider, cwd)) ?? []), ...path, ...installs(provider)])].filter(
    path => executable(path) && !metadata.shim(path),
  );
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
export async function resolve(
  provider: Provider,
  cwd: string | null = null,
  { stubs = false }: { stubs?: boolean } = {},
): Promise<string> {
  const { version } = adapter(provider),
    set = override(provider);
  if (set !== undefined && (set.length || !version)) return set;
  cwd ??= process.cwd();
  const manager = onPath("mise"),
    paths: string[] = [];
  if (manager) {
    const found = await Promise.all(commands(provider).map(name => metadata.mise(manager, name, cwd!)));
    for (const install of found) {
      if (!install || !executable(install.path) || metadata.shim(install.path)) continue;
      paths.push(install.path);
      if (!packaged(provider, install.path) && install.version !== null) {
        const line = adapter(provider).distribution?.version(install.version);
        if (line) remember(provider, install.path, line);
      }
    }
  }
  managed.set(context(provider, cwd), paths);
  const available = candidates(provider, cwd);
  if (stubs && !available.length) {
    const stub = stubOf(provider, cwd);
    if (stub) return stub;
  }
  if (!version) {
    const path = available[0];
    if (!path) throw Error("ProviderNotFound");
    packaged(provider, path);
    return path;
  }
  const deadline = performance.now() + 2000,
    quit = subprocess.Quit.init(),
    probes: Promise<string | null>[] = [];
  let report!: (path: string) => void;
  const found = new Promise<string>(resolve => (report = resolve));
  const probe = async (candidate: string, timeout_ms: number) => {
    try {
      const at = stamp(candidate),
        output = await subprocess.run([candidate, "--version"], {
          timeout_ms,
          max_output: 4096,
          quit,
          // Wrapper scripts must not install an agent during discovery.
          env: {
            ...process.env,
            MISE_AUTO_INSTALL: "0",
            MISE_EXEC_AUTO_INSTALL: "0",
            MISE_NOT_FOUND_AUTO_INSTALL: "0",
          },
        });
      if (!output.ok()) {
        if (at === stamp(candidate)) remember(provider, candidate, null);
        return null;
      }
      const stdout = output.stdout.toString(),
        ok = version(stdout);
      if (at) verdicts.set(candidate, { stamp: at, ok, version: stdout.trim().split("\n")[0] || null });
      if (ok) {
        report(candidate);
        return candidate;
      }
    } catch {
      if (!quit.aborted) remember(provider, candidate, null);
    }
    return null;
  };
  try {
    for (const candidate of available) {
      const known = packaged(provider, candidate) ?? verdict(candidate);
      if (known && known.version !== null) {
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
  throw Error(outdated(provider, cwd) === null ? "ProviderNotFound" : "ProviderTooOld");
}
/** The first executable `name` on PATH that isn't Corgi itself: a pane-local
 * alias would otherwise exec Corgi again. */
export function onPath(name: string, path_list = process.env.PATH ?? ""): string | null {
  const search = PathSearch.init(path_list, name);
  for (let path = search.next(); path !== null; path = search.next()) if (executable(path)) return path;
  return null;
}
/** Whether a real install is present, with a verified version when required. */
export function installed(provider: Provider, cwd = process.cwd()): boolean {
  const set = override(provider);
  if (set) return set.includes("/") ? executable(set) : onPath(set) !== null;
  return candidates(provider, cwd).some(candidate => {
    const known = packaged(provider, candidate) ?? verdict(candidate);
    return adapter(provider).version ? known?.ok === true : known?.ok !== false;
  });
}
/** Resolve mise selections and reject missing or unsupported installs. */
export async function check(cwd = process.cwd()): Promise<void> {
  await Promise.all(Provider.all.filter(p => override(p) === undefined).map(p => resolve(p, cwd).catch(() => {})));
}
/** A missing tool's mise dispatcher, which only an explicit launch may run. */
export function stubOf(provider: Provider, cwd = process.cwd()): string | null {
  if (override(provider) !== undefined || candidates(provider, cwd).length) return null;
  for (const dir of (process.env.PATH ?? "").split(":"))
    for (const command of commands(provider)) {
      const path = absolute(cwd, dir, command);
      if (executable(path) && metadata.shim(path)) return path;
    }
  return null;
}
export function onDemand(provider: Provider, cwd = process.cwd()): boolean {
  return stubOf(provider, cwd) !== null;
}
/** Wait for workspace discovery without invoking install-on-use dispatchers. */
export async function ready(providers: readonly Provider[] = Provider.all, cwd = process.cwd()): Promise<void> {
  await Promise.all(providers.map(provider => resolve(provider, cwd).catch(() => {})));
}
/** Discard version verdicts and resolve the selected workspace again. */
export async function rescan(providers: readonly Provider[] = Provider.all, cwd = process.cwd()): Promise<void> {
  for (const provider of providers) for (const candidate of candidates(provider, cwd)) verdicts.delete(candidate);
  await ready(providers, cwd);
}
