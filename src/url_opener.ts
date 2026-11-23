import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as linkThumbnail from "./link_thumbnail";
import * as paneBrowser from "./pane_browser";
import * as webLinks from "./web_links";

export class Openers {
  private children = new Set<Bun.Subprocess>();
  reap() {
    for (const child of this.children) if (child.exitCode !== null) this.children.delete(child);
  }
  open(url: string) {
    if (!webLinks.openable(url)) throw Error("InvalidURL");
    this.launch(url);
  }
  async openImage(path: string): Promise<void> {
    if (!isAbsolute(path) || !linkThumbnail.isImage(path)) throw Error("NotAnImage");
    const resolved = await realpath(path);
    if (!linkThumbnail.isImage(resolved) || !(await stat(resolved)).isFile()) throw Error("NotAnImage");
    // Desktop openers can launch other file types, so check the contents too.
    await new Bun.Image(Bun.file(resolved)).metadata();
    if ((await this.launch(resolved).exited) !== 0) throw Error("OpenImageFailed");
  }
  private launch(target: string): Bun.Subprocess {
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
}
