/** Pinned build-only npm tools, installed under .tools/<name> on first use. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const root = join(import.meta.dir, "..");
const cache =
  process.env.BUN_INSTALL_CACHE_DIR ?? join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "cache");

function matches(directory: string, version: string): boolean {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version === version;
  } catch {
    return false;
  }
}

function installed(tooling: string, name: string, version: string): string | null {
  for (const directory of [join(root, "node_modules", name), join(tooling, "node_modules", name)]) {
    if (matches(directory, version)) return directory;
  }
  const parent = name.startsWith("@") ? join(cache, name.split("/")[0]) : cache;
  const base = name.split("/").at(-1)!;
  try {
    for (const entry of readdirSync(parent).sort()) {
      if (entry.startsWith(`${base}@${version}@`)) {
        const directory = join(parent, entry);
        if (matches(directory, version)) return directory;
      }
    }
  } catch {}
  return null;
}

/** Returns each package's directory, in the order of `versions`. */
export async function packages(tool: string, versions: Record<string, string>): Promise<string[]> {
  const tooling = join(root, ".tools", tool);
  const find = () => Object.entries(versions).map(([name, version]) => installed(tooling, name, version));
  let found = find();
  if (found.some(directory => directory === null)) {
    console.error(`Installing pinned build-only ${tool} tooling in .tools/${tool}`);
    mkdirSync(tooling, { recursive: true });
    writeFileSync(
      join(tooling, "package.json"),
      JSON.stringify({ name: `corgi-${tool}-tooling`, private: true, dependencies: versions }, null, 2) + "\n",
    );
    const install = Bun.spawn(
      [process.execPath, "install", ...(existsSync(join(tooling, "bun.lock")) ? ["--frozen-lockfile"] : [])],
      { cwd: tooling, stdout: "inherit", stderr: "inherit" },
    );
    if ((await install.exited) !== 0) throw Error(`${tool} tooling installation failed`);
    found = find();
  }
  if (found.some(directory => directory === null)) throw Error(`Pinned ${tool} packages are unavailable`);
  return found as string[];
}

const sources = ["*.ts", "{src,tests,evals,tools,scripts}/**/*.ts"];

/** Formats the TypeScript sources, or with "check" lists the ones that need it. */
export async function prettier(mode: "check" | "write"): Promise<number> {
  const [prettier] = await packages("format", { prettier: "3.9.9" });
  const cache = join(root, ".tools", "format", ".prettier-cache");
  const flags = mode === "check" ? ["--list-different"] : ["--write", "--log-level", "warn"];
  const run = Bun.spawn(
    [
      process.execPath,
      join(prettier, "bin", "prettier.cjs"),
      ...flags,
      "--cache",
      "--cache-strategy",
      "content",
      "--cache-location",
      cache,
      ...sources,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const code = await run.exited;
  if (mode === "check" && code === 1) console.error("These files need formatting; run bun format.ts");
  return code;
}
