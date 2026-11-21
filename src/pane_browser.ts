//! The browser a pane's programs open links with. Each pane's BROWSER and,
//! on Linux, an `xdg-open` ahead of the system's on its PATH hand a web link
//! to the viewer looking at the pane, which opens it on its own computer,
//! forwarded when it points at this machine's loopback. A link no viewer
//! takes goes where it would have gone without Corgi.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as os from "./os";

/** The script BROWSER names, in the helpers' folder. */
export const helper = "corgi-browser";
/** Set on what opens a link Corgi passed on, so a helper it reaches hands it
 * on rather than back. */
export const passthrough = "CORGI_BROWSER_PASSTHROUGH";
/** The BROWSER panes would have had, for links no viewer takes. */
export const original = "CORGI_HOST_BROWSER";

/** The helpers' scripts, each running `cli`. */
export function scripts(cli: string, platform: string = process.platform): Record<string, string> {
  const corgi = os.shellQuote(cli);
  const out: Record<string, string> = { [helper]: `#!/bin/sh\nexec ${corgi} __browser "$@"\n` };
  // A program already running keeps its BROWSER, but finds this on its PATH.
  if (platform === "linux")
    out["xdg-open"] = [
      "#!/bin/sh",
      "# Corgi's: a web link opens on the computer viewing this pane; anything else as before.",
      `if [ $# -eq 1 ] && [ -z "\${${passthrough}-}" ]; then`,
      `  case "$1" in http://*|https://*) exec ${corgi} __browser --via "$0" "$1" ;; esac`,
      "fi",
      "IFS=:",
      "for dir in $PATH; do",
      '  [ -n "$dir" ] && [ -x "$dir/xdg-open" ] && ! [ "$dir/xdg-open" -ef "$0" ] && exec "$dir/xdg-open" "$@"',
      "done",
      'echo "xdg-open: not found" >&2',
      "exit 3",
      "",
    ].join("\n");
  return out;
}
/** Writes the helpers where panes find them, and says where: beside an
 * installed launcher `cli`, whose folder every pane's PATH already starts
 * with, so programs that were running before find them too; else beside the
 * daemon's `socket`. Null when they can't be written. */
export function install(cli: string, executable: string, socket: string): string | null {
  const folder = cli !== executable ? dirname(cli) : isAbsolute(socket) ? `${socket}.browser` : null;
  if (folder === null) return null;
  try {
    for (const [name, text] of Object.entries(scripts(cli))) {
      const path = join(folder, name);
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {}
      if (current !== text) os.atomicWrite(path, text, 0o700);
    }
    return folder;
  } catch {
    return null;
  }
}
/** What a pane's environment gains for the helpers in `folder`, given the
 * daemon's own `env`. */
export function environment(folder: string, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  // A daemon started from a pane has the helper as its BROWSER already.
  const host = env.BROWSER && basename(env.BROWSER) !== helper ? env.BROWSER : env[original];
  return { BROWSER: join(folder, helper), [original]: host, [passthrough]: undefined };
}

/** `corgi __browser [--via XDG_OPEN] URL`: asks the daemon to have the viewer
 * showing this pane open the link, or else opens it where it would have
 * gone. Returns the exit status. */
export async function run(
  args: string[],
  ask: (url: string, pane: number) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let via: string | null = null;
  if (args[0] === "--via") {
    via = args[1] ?? null;
    args = args.slice(2);
  }
  const pane = env.CORGI_PANE;
  if (!env[passthrough] && pane && /^\d+$/.test(pane) && args.length === 1 && /^https?:\/\//i.test(args[0]))
    try {
      await ask(args[0], Number(pane));
      return 0;
    } catch {}
  return fallback(args, via, env);
}
/** Opens `urls` as they'd have opened without Corgi: through `via`, the
 * xdg-open Corgi's stood in for; else the pane's own BROWSER; else the
 * system's opener; else it asks the person to. */
function fallback(urls: string[], via: string | null, env: NodeJS.ProcessEnv): number {
  const handed = { ...env, [passthrough]: "1" },
    status = (command: string, argv: string[]) => {
      const result = spawnSync(command, argv, { stdio: "inherit", env: handed });
      return result.error ? null : (result.status ?? 1);
    };
  if (via) return status(via, urls) ?? 127;
  // Python's convention: commands apart by colons, the link at %s or last.
  if (urls.length === 1)
    for (const command of (env[original] ?? "").split(":").filter(Boolean)) {
      const script = command.includes("%s") ? command.replaceAll("%s", '"$1"') : `${command} "$1"`;
      if (status("/bin/sh", ["-c", script, "sh", urls[0]]) === 0) return 0;
    }
  if (urls.length && status(process.platform === "darwin" ? "open" : "xdg-open", urls) === 0) return 0;
  for (const url of urls) process.stderr.write(`Open this link in your browser: ${url}\n`);
  return 1;
}
