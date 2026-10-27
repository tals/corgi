import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { CodexObserver, write_codex_terminal } from "./provider_sim";
import { Viewer } from "./viewer_client";
import { EXE, registerCase, run, shellJoin } from "./support";

const session = "01901234-1234-1234-1234-123456789abc";
class WorktreeReload extends Runtime {
  async configure() {
    this.env.CORGI_CODEX_BIN = write_codex_terminal(join(this.temp.name, "codex"), session);
  }
  async test_idle_worktree_agent_survives_reload_and_observation_resumes_without_new_title() {
    const root = realpathSync(this.temp.name),
      child = join(root, "linked");
    const git = (...args: string[]) => run(["git", "-C", root, ...args], { env: this.env });
    await git("init", "-b", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base");
    await git("worktree", "add", "-b", "feature", child);
    const terminal = write_codex_terminal(join(root, "codex"), session);
    await this.command("workspace.edit", { target: 1, cwd: root });
    let pane = (await this.command("pane.create", { workspace: 1, cwd: root, command: shellJoin([terminal]) })).pane;
    const viewer = await Viewer.create(this, 120, 38);
    let observer = new CodexObserver(this.env.CODEX_HOME!, [session]);
    observer.names[session] = "Worktree agent";
    observer.cwds[session] = root;
    observer.items[session] = [{ type: "commandExecution", id: "command", cwd: child, status: "completed" }];
    const placement = async () =>
      (await this.session()).workspaces[0].worktrees?.agents.find((a: any) => a.target.pane === pane)?.path;
    const state = async () => (await this.session()).panes.find((p: any) => p.id === pane);
    try {
      await this.untilAdvancing(1, async () => (await placement()) === child);
      const pid = (await state()).pid;
      // The latest turn names only the launch directory; the placement must stick.
      observer.items[session] = [];
      observer.set_turn(session, "next", "completed");
      await observer.wait_for_request("thread/items/list", { after: observer.requests.length });
      await observer.close();
      await this.rpc({ op: "server.reload", executable: EXE });
      this.assertEqual(await placement(), child);
      this.assertEqual((await state()).pid, pid);
      await this.until(async () => (await viewer.poll()).data.includes("Worktree agent"));
      this.assertIn("feature", (await viewer.poll()).data);
      // No terminal input or fresh OSC title: the saved owner allows polling again.
      observer = new CodexObserver(this.env.CODEX_HOME!, [session]);
      observer.names[session] = "Still observed";
      observer.cwds[session] = root;
      await this.until(async () => (await state()).agent.name === "Still observed");
      await this.advance(4);
      await this.untilAdvancing(1, async () => (await placement()) === child);
      // Reopening must publish the new pane under its worktree before observation.
      await observer.close();
      await this.command("pane.close", { target: pane });
      pane = (await this.command("agent.resume", { workspace: 1, cwd: root, provider: "codex", session, asleep: true }))
        .pane;
      this.assertEqual(await placement(), child);
      this.assertTrue((await state()).dormant);
      observer = new CodexObserver(this.env.CODEX_HOME!, [session]);
      observer.names[session] = "Resumed again";
      observer.cwds[session] = root;
      await this.command("pane.wake", { target: pane });
      await this.until(async () => (await state()).agent.name === "Resumed again");
      this.assertEqual(await placement(), child);
      // An explicit move still clears the retained placement after reload.
      observer.cwds[session] = child;
      observer.items[session] = [{ type: "commandExecution", id: "leave", cwd: root, status: "completed" }];
      await this.untilAdvancing(1, async () => (await placement()) === root);

      // An unseen manual resume appears while its provider history is still pending.
      const unseen = "01911234-1234-1234-1234-123456789abc";
      observer.ids.push(unseen);
      observer.states[unseen] = "idle";
      observer.turns[unseen] = ["older", "completed"];
      observer.cwds[unseen] = root;
      observer.items[unseen] = [{ type: "commandExecution", id: "old-command", cwd: child, status: "completed" }];
      const gate = observer.hold("thread/items/list", unseen);
      const manual = write_codex_terminal(join(root, "manual", "codex"), unseen);
      pane = (await this.command("pane.create", { workspace: 1, cwd: root, command: shellJoin([manual, "resume"]) }))
        .pane;
      await gate.wait();
      this.assertEqual((await state()).agent.provider, "codex");
      this.assertEqual((await state()).cwd, root);
      this.assertFalse((await placement()) === child);
      gate.release();
      await this.untilAdvancing(1, async () => (await placement()) === child);
    } finally {
      await observer.close();
    }
  }
}
registerCase("WorktreeReload", WorktreeReload);
