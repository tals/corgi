import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as os from "./os";
/** The script at `<install>/bin/corgi` for `root`; it checks the version as the installer's launcher does. */
function script(root: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `root=${os.shellQuote(root)}`,
    'v=$(cat "$root/current")',
    `case "$v" in ''|*[!0-9.a-fTZ-]*) printf '%s\\n' 'Invalid Corgi version' >&2; exit 1;; esac`,
    'exec "$root/releases/$v/corgi" "$@"',
    "",
  ].join("\n");
}
/** A fixed path that runs the current release, for what outlives any one
 * release: pane shells' PATH and hand-installed hooks. `exe` itself when it
 * isn't an installed release. */
export function path(exe: string): string {
  const releases = dirname(dirname(exe)),
    root = dirname(releases);
  if (basename(releases) !== "releases" || !existsSync(join(root, "current"))) return exe;
  const bin = join(root, "bin", "corgi"),
    text = script(root);
  try {
    let current = "";
    try {
      if ((statSync(bin).mode & 0o777) === 0o700) current = readFileSync(bin, "utf8");
    } catch {}
    if (current !== text) os.atomicWrite(bin, text, 0o700);
    return bin;
  } catch {
    return exe;
  }
}
