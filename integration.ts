import { resolve } from "node:path";
import { existsSync } from "node:fs";
const repo = import.meta.dir;
const executable = process.env.CORGI_TEST_BIN ?? `${import.meta.dir}/dist/corgi-test`;
if (!existsSync(executable)) throw Error("Build the test executable first: bun build.ts --test");
const child = Bun.spawn([process.execPath, `${repo}/tests/run.ts`, ...process.argv.slice(2)], {
  cwd: repo,
  env: { ...process.env, CORGI_TEST_BIN: executable },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
