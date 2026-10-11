import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Scope } from "./scripts/process_scope";
const repo = import.meta.dir;
const executable = process.env.CORGI_TEST_BIN ?? `${import.meta.dir}/dist/corgi-test`;
if (!existsSync(executable)) throw Error("Build the test executable first: bun build.ts --test");
const scope = await Scope.start({ ...process.env, CORGI_TEST_BIN: executable });
const child = Bun.spawn([process.execPath, `${repo}/tests/run.ts`, ...process.argv.slice(2)], {
  cwd: repo,
  env: scope.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    interrupted = true;
    child.kill(signal);
    void scope.close().catch(error => console.error(error));
  });
try {
  process.exitCode = await child.exited;
} finally {
  try {
    await scope.assertClean();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  if (interrupted) process.exitCode = 130;
}
