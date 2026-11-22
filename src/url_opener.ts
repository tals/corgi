import * as paneBrowser from "./pane_browser";
import * as webLinks from "./web_links";

export class Openers {
  private children = new Set<Bun.Subprocess>();
  reap() {
    for (const child of this.children) if (child.exitCode !== null) this.children.delete(child);
  }
  open(url: string) {
    if (!webLinks.openable(url)) throw Error("InvalidURL");
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
