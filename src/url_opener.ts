export class Openers {
  private children = new Set<Bun.Subprocess>();
  reap() {
    for (const child of this.children) if (child.exitCode !== null) this.children.delete(child);
  }
  open(url: string) {
    if (!/^https?:\/\//.test(url) || /[\x00-\x1f\x7f]/.test(url)) throw Error("InvalidURL");
    this.reap();
    if (this.children.size >= 8) throw Error("TooManyOpenRequests");
    const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.children.add(child);
    void child.exited.then(() => this.children.delete(child));
  }
}
