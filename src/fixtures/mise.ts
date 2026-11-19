//! A home whose programs come from mise, as a test's stand-in writes them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopedEnv } from "./env";

/** Makes `root` the home, with only `root/bin` (for a fake `mise`) and mise's
 * shims in `root/shims` on PATH, and `values` set too, until disposed. */
export function home(root: string, values: Record<string, string | undefined>): Disposable {
  for (const name of ["bin", "shims"]) mkdirSync(join(root, name));
  return scopedEnv({
    PATH: join(root, "bin") + ":" + join(root, "shims"),
    HOME: root,
    CORGI_TEST_SYSTEM_ROOT: join(root, "system"),
    MISE_SHIMS_DIR: join(root, "shims"),
    MISE_DATA_DIR: undefined,
    MISE_CONFIG_DIR: undefined,
    XDG_DATA_HOME: undefined,
    ...values,
  });
}
/** A mise shim for `program` that fails, leaving a file behind; that file's path. */
export function shim(root: string, program: string): string {
  const ran = join(root, `${program}-shim-ran`);
  writeFileSync(join(root, "shims", program), `#!/bin/sh\n: > '${ran}'\nexit 1\n`, { mode: 0o755 });
  return ran;
}
