//! The browser a pane's programs open links with. Each pane's BROWSER hands a
//! web link to the viewer looking at the pane, which opens it on its own
//! computer, forwarded when it points at this machine's loopback. A link no
//! viewer takes goes where it would have gone without Corgi.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as os from "./os";
import * as webLinks from "./web_links";

/** The script BROWSER names, in the helper's folder. */
export const helper = "corgi-browser";
/** The BROWSER panes would have had, for links no viewer takes. */
export const original = "CORGI_HOST_BROWSER";

/** `browsers`, a BROWSER list, without Corgi's helper, which would hand a
 * link back. Undefined when nothing's left. */
function others(browsers: string | undefined): string | undefined {
  const kept = (browsers ?? "")
    .split(":")
    .filter(command => command.trim() && basename(command.trim().split(/\s+/)[0]) !== helper);
  return kept.length ? kept.join(":") : undefined;
}
/** The environment for what opens a link Corgi passed on: with the pane's own
 * BROWSER, since a system opener with no desktop to ask runs BROWSER, which
 * would be Corgi's helper again. */
export function handed(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, BROWSER: others(env[original]) ?? others(env.BROWSER) };
  if (out.BROWSER === undefined) delete out.BROWSER;
  return out;
}
/** The helper's script, running `cli`. */
export function script(cli: string): string {
  return `#!/bin/sh\nexec ${os.shellQuote(cli)} __browser "$@"\n`;
}
/** Writes the helper where panes find it, and says where: beside an
 * installed launcher `cli`, a fixed path that outlives any one release; else
 * beside the daemon's `socket`. Null when it can't be written. */
export function install(cli: string, executable: string, socket: string): string | null {
  const folder = cli !== executable ? dirname(cli) : isAbsolute(socket) ? `${socket}.browser` : null;
  if (folder === null) return null;
  const path = join(folder, helper),
    text = script(cli);
  try {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {}
    if (current !== text) os.atomicWrite(path, text, 0o700);
    // XXX: Remove once pre-release builds are gone: they left a Corgi xdg-open
    // here, which panes' PATH reaches ahead of the system's.
    const stale = join(folder, "xdg-open");
    try {
      if (readFileSync(stale, "utf8").split("\n")[1] === "# corgi-xdg-open") rmSync(stale);
    } catch {}
    return folder;
  } catch {
    return null;
  }
}
/** What a pane's environment gains for the helper in `folder`, given the
 * daemon's own `env`. */
export function environment(folder: string, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  // A daemon started from a pane has the helper as its BROWSER already.
  const host = others(env.BROWSER) ?? others(env[original]);
  return { BROWSER: join(folder, helper), [original]: host };
}

/** `corgi __browser URL`: asks the daemon to have the viewer showing this
 * pane open the link, or else opens it where it would have gone. Returns the
 * exit status. */
export async function run(
  urls: string[],
  ask: (url: string, pane: number) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const pane = env.CORGI_PANE;
  if (pane && /^\d+$/.test(pane) && urls.length === 1 && webLinks.openable(urls[0]))
    try {
      await ask(urls[0], Number(pane));
      return 0;
    } catch {}
  return fallback(urls, env);
}
/** Opens `urls` as they'd have opened without Corgi: through the pane's own
 * BROWSER; else the system's opener; else it asks the person to. */
function fallback(urls: string[], env: NodeJS.ProcessEnv): number {
  const status = (command: string, argv: string[]) => {
    const result = spawnSync(command, argv, { stdio: "inherit", env: handed(env) });
    return result.error ? null : (result.status ?? 1);
  };
  // Python's convention: commands apart by colons, the link at %s or last.
  if (urls.length === 1)
    for (const command of (others(env[original]) ?? "").split(":").filter(Boolean)) {
      const script = command.includes("%s") ? command.replaceAll("%s", '"$1"') : `${command} "$1"`;
      if (status("/bin/sh", ["-c", script, "sh", urls[0]]) === 0) return 0;
    }
  if (urls.length && status(process.platform === "darwin" ? "open" : "xdg-open", urls) === 0) return 0;
  for (const url of urls) process.stderr.write(`Open this link in your browser: ${url}\n`);
  return 1;
}
