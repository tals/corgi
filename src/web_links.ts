//! Web links as this computer's browser opens them: one rule for a click, a
//! pane's BROWSER, the daemon passing it on and the opener itself, and
//! whether this viewer has a browser at all.
import { sshViewer } from "./trackers/ports";
import { byteLength } from "./text";

/** An http(s) link, its scheme in any case, with no control characters, of at
 * most 4096 bytes; native `linkIn` (pane/terminal.zig) picks the same ones. */
export function openable(uri: string): boolean {
  return /^https?:\/\//i.test(uri) && !/[\x00-\x1f\x7f]/.test(uri) && byteLength(uri) <= 4096;
}
/** Whether this viewer has a browser to open links in: not over SSH, and on
 * Linux with a display, as WSL's has, rather than a console's or a container's. */
export function opensLinks(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (sshViewer(env)) return false;
  return platform !== "linux" || !!(env.DISPLAY || env.WAYLAND_DISPLAY || env.WSL_DISTRO_NAME);
}
