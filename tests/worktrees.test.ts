import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, run } from "./support";

class Worktrees extends Runtime {
  async git(cwd: string, ...args: string[]) {
    return (await run(["git", "-C", cwd, ...args], { env: this.env })).stdout;
  }
  async configure() {
    const root = this.temp.name;
    await this.git(root, "init", "-b", "main");
    await this.git(root, "config", "user.name", "Test");
    await this.git(root, "config", "user.email", "test@example.invalid");
    await this.git(root, "config", "commit.gpgsign", "false");
    await this.git(root, "commit", "--allow-empty", "-m", "base");
    mkdirSync(join(root, ".worktrees"));
    await this.git(root, "worktree", "add", "-b", "feat/search", join(root, ".worktrees/search"));
    await this.git(root, "worktree", "add", "-b", "fix/clipboard", join(root, ".worktrees/clipboard"));
    await this.git(join(root, ".worktrees/search"), "commit", "--allow-empty", "-m", "feature");
    const project = join(this.env.CLAUDE_CONFIG_DIR!, "projects", "worktrees");
    mkdirSync(project, { recursive: true });
    for (let i = 0; i < 5; i++)
      writeFileSync(
        join(project, `00000000-0000-4000-8000-00000000000${i}.jsonl`),
        JSON.stringify({
          type: "user",
          cwd: realpathSync(join(root, ".worktrees/clipboard")),
          message: { role: "user", content: `Checkout history ${i}` },
        }) + "\n",
      );
  }
  async test_count_hover_details_and_pinning_use_real_git_without_agents() {
    await this.command("workspace.edit", { target: (await this.session()).workspaces[0].id, cwd: this.temp.name });
    await this.advance(4);
    await this.until(async () => (await this.session()).workspaces[0].worktrees?.entries.length === 3);
    const a = await Viewer.create(this, 120, 38),
      b = await Viewer.create(this, 120, 38);
    await this.advance(4);
    await this.until(async () => (await this.session()).workspaces[0].worktrees?.entries.length === 3);
    this.assertIn("2 worktrees", (await a.poll()).data);
    await a.input("\x1b[<35;20;4M");
    await a.advance(0.6);
    this.assertIn("Compared with local main", (await a.poll()).data);
    this.assertNotIn("Compared with local main", (await b.poll()).data);
    await this.until(async () => (await a.poll()).data.includes("Checkout history"), 15);
    this.assertIn("… more (2)", (await a.poll()).data);
    this.assertIn("╭┄┄┄", (await a.poll()).data);
    await this.until(
      async () =>
        (await this.session()).workspaces[0].worktrees.entries.find((e: any) => e.branch === "refs/heads/feat/search")
          ?.comparison?.ahead === 1,
    );
    await a.input("\x1b[B");
    this.assertIn("Pinned", (await a.poll()).data);
    this.assertIn("Compared with local main", (await a.poll()).data);
    writeFileSync(join(this.temp.name, ".worktrees/search/new-file"), "work\n");
    await this.advance(4);
    await this.until(
      async () =>
        (await this.session()).workspaces[0].worktrees.entries.find((e: any) => e.branch === "refs/heads/feat/search")
          ?.changes?.untracked === 1,
    );
    const frame = (await a.poll()).data;
    this.assertIn("AGENTS", frame);
    this.assertIn("AHEAD", frame);
    this.assertIn("BEHIND", frame);
    this.assertNotIn("Summary", frame);
    writeFileSync("/tmp/corgi-worktree-table-screen.txt", screen_text(frame, 120, 38).join("\n"));
    await a.input("\x1b[27u");
    this.assertNotIn("Compared with local main", (await a.poll()).data);
    this.assertIn("2 worktrees", a.state.data);
    await a.input("\x1b[<0;20;4M\x1b[<0;20;4m");
    await a.input("\r");
    this.assertNotIn("Compared with local main", (await a.poll()).data);
    this.assertIn("Checkout history", a.state.data);
    this.assertNotIn("╭┄┄┄", a.state.data);
  }
}
registerCase("Worktrees", Worktrees);
