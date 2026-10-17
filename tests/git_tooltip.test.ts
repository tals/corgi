import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, run, sleep } from "./support";

class GitTooltip extends Runtime {
  viewers: Viewer[] = [];
  async setUp() {
    await super.setUp();
    for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CORGI_PANE"]) delete this.env[key];
  }
  async tearDown() {
    for (const viewer of this.viewers) await viewer.close();
    await super.tearDown();
  }
  // Not the home workspace's folder: Corgi has already found it isn't a
  // repository, and looks again only after 30 s.
  get repo() {
    return join(this.temp.name, "repo");
  }
  async git(...args: string[]) {
    return (await run(["git", "-C", this.repo, ...args], { env: this.env })).stdout.trim();
  }
  async new() {
    return (
      await this.command("pane.create", {
        workspace: (await this.session()).workspaces[0].id,
        cwd: this.repo,
        command: "sleep 60",
      })
    ).pane;
  }
  async test_hover_metadata_is_local_and_refreshes_after_push() {
    mkdirSync(this.repo);
    await this.git("init", "-b", "main");
    await this.git("config", "user.name", "Corgi Author");
    await this.git("config", "user.email", "test@example.invalid");
    await this.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base");
    await this.git("branch", "upstream");
    await this.git("branch", "--set-upstream-to=upstream");
    for (let i = 0; i < 14; i++)
      await this.git(
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        `Change ${String(i).padStart(2, "0")} — tooltip metadata`,
      );
    await this.new();
    await this.until(async () => (await this.session()).workspaces[0].git_ahead === 14);
    const a = await Viewer.create(this),
      b = await Viewer.create(this);
    this.viewers.push(a, b);
    await a.input("\x1b[<35;25;3M");
    this.assertNotIn("14 unpushed commits", a.state.data);
    await a.advance(0.6);
    const frame = (await a.poll()).data;
    for (const text of ["14 unpushed commits", "Change 13 — tooltip metadata", "Corgi Author", "+2 more", "just now"])
      this.assertIn(text, frame);
    this.assertRegex(frame, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    for (const text of ["Newest first", "newest first", "compared with upstream"]) this.assertNotIn(text, frame);
    this.assertNotIn("14 unpushed commits", (await b.poll()).data);
    const clean = frame
      .replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "")
      .replace(/\x1b7/g, "")
      .replace(/\x1b8/g, "");
    writeFileSync("/tmp/corgi-git-tooltip-screen.txt", screen_text(clean, 120, 40).join("\n"));
    await a.input("\x1b[<35;5;3M");
    this.assertNotIn("14 unpushed commits", a.state.data);
    await a.input("\x1b[<35;25;3M");
    await a.advance(0.6);
    this.assertIn("14 unpushed commits", (await a.poll()).data);
    await a.input("x");
    this.assertNotIn("14 unpushed commits", a.state.data);
    await this.git("branch", "-f", "upstream", "HEAD");
    await this.until(async () => (await this.session()).workspaces[0].git_ahead === 0);
    await a.input("\x1b[<35;24;3M");
    await a.advance(0.6);
    this.assertNotIn("unpushed commits", (await a.poll()).data);
    this.assertEqual((await this.session()).workspaces[0].git_commits, []);
  }
}
registerCase("GitTooltip", GitTooltip);
