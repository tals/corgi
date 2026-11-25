import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as linkThumbnail from "./link_thumbnail";
import * as paneBrowser from "./pane_browser";
import * as webLinks from "./web_links";

/** How long an opener counts as launching. Without a desktop's own opener,
 * xdg-open runs the viewer in the foreground until its window closes. */
const launch_ms = 2000;

export class Openers {
  private children = new Set<Bun.Subprocess>();
  constructor(private launching_ms = launch_ms) {}
  reap() {
    for (const child of this.children) if (child.exitCode !== null) this.children.delete(child);
  }
  open(url: string) {
    if (!webLinks.openable(url)) throw Error("InvalidURL");
    this.spawn(url);
  }
  async openImage(path: string): Promise<void> {
    if (!isAbsolute(path) || !linkThumbnail.isImage(path)) throw Error("NotAnImage");
    const resolved = await realpath(path);
    if (!linkThumbnail.isImage(resolved) || !(await stat(resolved)).isFile()) throw Error("NotAnImage");
    // Desktop openers can launch other file types, so check the contents too.
    if (!linkThumbnail.startsImage(await Bun.file(resolved).slice(0, 16).bytes())) throw Error("NotAnImage");
    const code = await this.launch(resolved);
    if (code !== null && code !== 0) throw Error("OpenImageFailed");
  }
  /** Starts an opener, which counts toward the limit until it exits: a
   * pane's program can ask for links and images. */
  private spawn(target: string): Bun.Subprocess {
    this.reap();
    if (this.children.size >= 8) throw Error("TooManyOpenRequests");
    const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", target], {
      // A viewer started in a Corgi pane has its helper as BROWSER, which a system opener with no desktop would hand the link back to.
      env: paneBrowser.handed(process.env),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.children.add(child);
    void child.exited.then(() => this.children.delete(child));
    return child;
  }
  /** Opens an image: the opener's exit code if it exits while launching;
   * null if it's still running, as a viewer it runs in the foreground is. */
  private async launch(target: string): Promise<number | null> {
    const child = this.spawn(target);
    let timer: Timer | undefined;
    const code = await Promise.race([
      child.exited,
      new Promise<null>(resolve => (timer = setTimeout(resolve, this.launching_ms, null))),
    ]);
    clearTimeout(timer);
    return code;
  }
}
