import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const repository = path.resolve(import.meta.dir, "../..");
export const historicalRun = "20261111-network-history-d08257db";

export function external(directory: string): string {
  const absolute = path.resolve(directory);
  let existing = absolute;
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) existing = path.dirname(existing);
  const resolved = path.resolve(fs.realpathSync(existing), path.relative(existing, absolute));
  const relative = path.relative(fs.realpathSync(repository), resolved);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
    throw Error("Benchmark data must be outside the checkout; use the benchmark cache");
  return resolved;
}

export function cache(): string {
  return external(
    process.env.CORGI_BENCHMARK_CACHE ??
      path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "corgi/benchmarks"),
  );
}

export function run(label: string): string {
  return path.join(
    cache(),
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${crypto.randomUUID().slice(0, 8)}`,
  );
}

export function corpus(): string {
  const directory = external(
    process.env.CORGI_BENCHMARK_CORPUS ??
      path.join(cache(), historicalRun, "tools/benchmarks/remote_network/websocket_eval/fixtures"),
  );
  if (!fs.existsSync(path.join(directory, "manifest.json")))
    throw Error(
      `Missing replay corpus. Run: bun tools/benchmarks/artifacts.ts fetch ${historicalRun}; or set CORGI_BENCHMARK_CORPUS`,
    );
  return directory;
}
