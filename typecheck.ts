import { mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as tooling from "./scripts/tooling";

const root = import.meta.dir;
const [compiler, bunTypes, nodeTypes] = await tooling.packages("typecheck", {
  typescript: "6.0.3",
  "bun-types": "1.4.2",
  "@types/node": "26.6.4",
});

// Give tsc conventional type package names even when Bun's cache adds suffixes.
const typeRoots = join(root, ".tools", "typecheck", "types");
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
const codes = await Promise.all([check.exited, tooling.prettier("check")]);
process.exitCode = codes.find(code => code !== 0) ?? 0;
