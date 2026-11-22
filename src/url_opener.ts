import * as paneBrowser from "./pane_browser";
import { sshViewer } from "./trackers/ports";

/** Whether this viewer has a browser to open links in: not over SSH, and on
 * Linux with a display, as WSL's has, rather than a console's or a container's. */
export function opensLinks(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (sshViewer(env)) return false;
  return platform !== "linux" || !!(env.DISPLAY || env.WAYLAND_DISPLAY || env.WSL_DISTRO_NAME);
}

export class Openers {
  private children = new Set<Bun.Subprocess>();
  reap() {
    for (const child of this.children) if (child.exitCode !== null) this.children.delete(child);
  }
  open(url: string) {
    if (!/^https?:\/\//i.test(url) || /[\x00-\x1f\x7f]/.test(url)) throw Error("InvalidURL");
    this.reap();
    if (this.children.size >= 8) throw Error("TooManyOpenRequests");
    const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
      // A Corgi pane's xdg-open hands links to its viewer: this one opens them.
      env: paneBrowser.handed(process.env),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.children.add(child);
    void child.exited.then(() => this.children.delete(child));
  }
}
