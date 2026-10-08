import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const tooling = join(root, ".tools", "typecheck");
const versions = {
  typescript: "6.0.3",
  "bun-types": "1.4.2",
  "@types/node": "26.6.4",
};
const cache =
  process.env.BUN_INSTALL_CACHE_DIR ??
  join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "cache");

function matches(directory: string, version: string): boolean {
  try {
    return (
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
        .version === version
    );
  } catch {
    return false;
  }
}

function installed(name: string, version: string): string | null {
  for (const directory of [
    join(root, "node_modules", name),
    join(tooling, "node_modules", name),
  ]) {
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

let packages = Object.entries(versions).map(([name, version]) =>
  installed(name, version),
);
if (packages.some((directory) => directory === null)) {
  console.error(
    "Installing pinned build-only typecheck tooling in app/.tools/typecheck",
  );
  mkdirSync(tooling, { recursive: true });
  writeFileSync(
    join(tooling, "package.json"),
    JSON.stringify(
      {
        name: "corgi-typecheck-tooling",
        private: true,
        dependencies: versions,
      },
      null,
      2,
    ) + "\n",
  );
  const install = Bun.spawn(
    [
      process.execPath,
      "install",
      ...(existsSync(join(tooling, "bun.lock")) ? ["--frozen-lockfile"] : []),
    ],
    {
      cwd: tooling,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await install.exited) !== 0)
    throw Error("Typecheck tooling installation failed");
  packages = Object.entries(versions).map(([name, version]) =>
    installed(name, version),
  );
}
const [compiler, bunTypes, nodeTypes] = packages;
if (!compiler || !bunTypes || !nodeTypes)
  throw Error("Pinned typecheck packages are unavailable");

// Give tsc conventional type package names even when Bun's cache adds suffixes.
const typeRoots = join(tooling, "types");
mkdirSync(typeRoots, { recursive: true });
for (const [name, directory] of [
  ["bun-types", bunTypes],
  ["node", nodeTypes],
]) {
  const link = join(typeRoots, name);
  try {
    unlinkSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  symlinkSync(directory, link, "dir");
}
const check = Bun.spawn(
  [
    process.execPath,
    join(compiler, "bin", "tsc"),
    "-p",
    join(root, "tsconfig.json"),
    "--types",
    "bun-types,node",
    "--typeRoots",
    typeRoots,
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await check.exited;
