import {
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { registerCase, run, sleep } from "./support";

class GitPush extends Runtime {
  root!: string;
  remote!: string;
  gitViewer!: Viewer;

  async setUp() {
    await super.setUp();
    this.root = this.temp.name;
    await this.git("init", "-b", "main");
    await this.git("config", "user.name", "Push Test");
    await this.git("config", "user.email", "test@example.invalid");
    await this.commit("base");
    this.remote = join(this.root, "remote.git");
    await this.git("init", "--bare", this.remote);
    await this.git("remote", "add", "origin", this.remote);
    await this.git("push", "-u", "origin", "main");
    await this.commit("ready to push");
    await this.new();
    await this.untilAdvancing(
      3,
      async () => (await this.workspace()).git_ahead === 1,
    );
    this.gitViewer = await Viewer.create(this);
  }

  async tearDown() {
    await this.gitViewer?.close();
    await super.tearDown();
  }

  async git(...args: string[]) {
    const result = await run(["git", "-C", this.temp.name, ...args], {
      env: this.env,
    });
    return result.stdout.trim();
  }
  async commit(message: string) {
    await this.git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      message,
    );
  }
  async new() {
    return (
      await this.command("pane.create", {
        workspace: (await this.session()).workspaces[0].id,
        cwd: this.temp.name,
        command: "sleep 60",
      })
    ).pane;
  }
  async workspace() {
    return (await this.session()).workspaces[0];
  }
  row(viewer: Viewer = this.gitViewer) {
    return screen_text(viewer.state.data, 100, 30)[2];
  }
  async hover(x = 25, y = 3, viewer: Viewer = this.gitViewer) {
    await viewer.input(`\x1b[<35;${x};${y}M`);
  }
  async click(x = 25, y = 3, viewer: Viewer = this.gitViewer) {
    await viewer.input(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
  }
  hook(body: string) {
    const path = join(this.remote, "hooks", "pre-receive");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o700);
    return path;
  }

  async test_hover_shared_progress_and_success() {
    const other = await Viewer.create(this);
    try {
      const original = this.row();
      this.assertIn("↑1", original);
      await this.hover();
      this.assertIn("Push ↑1", this.row());
      this.assertEqual(original.indexOf("↑1"), this.row().indexOf("↑1"));
      this.assertNotIn("Push ↑1", this.row(other));
      await this.hover(21);
      this.assertIn("Push ↑1", this.row());
      await this.hover(5);
      this.assertNotIn("Push ↑1", this.row());
      await this.hover();
      await this.gitViewer.advance(0.6);
      this.assertIn("ready to push", (await this.gitViewer.poll()).data);
      writeFileSync(
        "/tmp/corgi-git-push-hover.txt",
        screen_text(this.gitViewer.state.data, 100, 30).join("\n"),
      );
      const calls = join(this.remote, "calls");
      this.hook(`echo push >> "${calls}"\nsleep 1`);
      await this.git("branch", "unrelated");
      await this.git("tag", "unrelated-tag");
      await this.git("config", "remote.origin.mirror", "true");
      await this.git("config", "push.followTags", "true");
      await this.click();
      this.assertIn("Pushing", this.row());
      this.assertIn("Pushing", (await other.poll()).data);
      await this.click(25, 3, other);
      await this.click();
      await this.until(
        async () => (await this.workspace()).git_push.phase !== "pushing",
      );
      this.assertEqual((await this.workspace()).git_push.phase, "succeeded");
      this.assertIn("Pushed ✓", (await this.gitViewer.poll()).data);
      this.assertEqual(
        await this.git("rev-parse", "HEAD"),
        await this.git("--git-dir", this.remote, "rev-parse", "main"),
      );
      this.assertEqual(readFileSync(calls, "utf8").trim().split("\n"), [
        "push",
      ]);
      this.assertEqual(
        await this.git(
          "--git-dir",
          this.remote,
          "for-each-ref",
          "--format=%(refname)",
        ),
        "refs/heads/main",
      );
      await this.untilAdvancing(3, async () => {
        const ws = await this.workspace();
        return ws.git_ahead === 0 && ws.git_push.phase === "idle";
      });
      this.assertNotIn("↑1", (await this.gitViewer.poll()).data);
    } finally {
      await other.close();
    }
  }

  async test_failure_is_visible_without_moving_and_retry_works() {
    const hook = this.hook('echo "fixture rejected this push" >&2\nexit 1');
    await this.hover();
    await this.click();
    await this.until(
      async () => (await this.workspace()).git_push.phase === "failed",
    );
    const frame = (await this.gitViewer.poll()).data;
    this.assertIn("Retry !", frame);
    this.assertIn("fixture rejected this push", frame);
    this.assertIn("Push failed", frame);
    unlinkSync(hook);
    await this.click();
    await this.untilAdvancing(
      3,
      async () => (await this.workspace()).git_ahead === 0,
    );
  }

  async test_stale_preview_and_non_fast_forward_never_force() {
    const before = await this.workspace();
    await this.commit("created after the preview");
    const response = await this.raw_rpc({
      op: "git.push",
      protocol: 1,
      workspace: before.id,
      ref: before.git_ref,
    });
    if (response.ok)
      await this.until(
        async () => (await this.workspace()).git_push.phase === "failed",
      );
    else this.assertEqual(response.err, "GitPreviewChanged");
    this.assertNotEqual(
      await this.git("rev-parse", "HEAD"),
      await this.git("--git-dir", this.remote, "rev-parse", "main"),
    );
    await this.untilAdvancing(
      3,
      async () => (await this.workspace()).git_ahead === 2,
    );
    const tree = await this.git("rev-parse", "HEAD^{tree}");
    const base = await this.git("rev-parse", "origin/main");
    const remoteTip = await this.git(
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      "remote-only",
    );
    await this.git("push", "origin", `${remoteTip}:refs/heads/other`);
    await this.git(
      "--git-dir",
      this.remote,
      "update-ref",
      "refs/heads/main",
      remoteTip,
    );
    await this.gitViewer.poll();
    await this.hover();
    await this.click();
    await this.until(
      async () => (await this.workspace()).git_push.phase === "failed",
    );
    this.assertEqual(
      remoteTip,
      await this.git("--git-dir", this.remote, "rev-parse", "main"),
    );
  }

  async test_background_workspace_push_does_not_switch_selection() {
    const second = (
      await this.command("workspace.create", {
        cwd: this.remote,
        name: "elsewhere",
      })
    ).workspace;
    await this.gitViewer.poll();
    await this.gitViewer.request({ op: "workspace", workspace: second });
    await this.hover();
    await this.click();
    this.assertEqual(this.gitViewer.state.workspace, second);
    await this.untilAdvancing(
      3,
      async () => (await this.workspace()).git_ahead === 0,
    );
    this.assertEqual((await this.gitViewer.poll()).workspace, second);
  }

  /** A push that stays in progress until the test calls the returned release. */
  heldPush() {
    const marker = join(this.remote, "started"),
      gate = join(this.remote, "release");
    this.hook(
      `touch "${marker}"\nwhile [ ! -e "${gate}" ]; do sleep 0.05; done`,
    );
    return {
      started: () => existsSync(marker),
      release: () => writeFileSync(gate, ""),
    };
  }
  async test_push_freezes_commit_and_finishes_after_checkout_changes() {
    const push = this.heldPush();
    const expected = await this.git("rev-parse", "HEAD");
    await this.hover();
    await this.click(21);
    await this.until(push.started);
    await this.commit("created while pushing");
    await this.git("checkout", "--detach");
    await this.untilAdvancing(
      3,
      async () => (await this.workspace()).git_ref.head === "",
    );
    push.release();
    await this.until(
      async () => (await this.workspace()).git_push.phase !== "pushing",
    );
    await this.until(
      async () =>
        expected ===
        (await this.git("--git-dir", this.remote, "rev-parse", "main")),
    );
  }

  async test_changed_upstream_is_rejected_and_local_upstream_can_push() {
    const before = await this.workspace();
    await this.git("branch", "local-upstream", "origin/main");
    const base = await this.git("rev-parse", "local-upstream");
    await this.git("branch", "--set-upstream-to=local-upstream");
    const response = await this.raw_rpc({
      op: "git.push",
      protocol: 1,
      workspace: before.id,
      ref: before.git_ref,
    });
    if (response.ok) {
      await this.until(
        async () => (await this.workspace()).git_push.phase === "failed",
      );
      this.assertIn(
        "upstream changed",
        (await this.workspace()).git_push.message,
      );
    } else this.assertEqual(response.err, "GitPreviewChanged");
    this.assertEqual(base, await this.git("rev-parse", "local-upstream"));
    await this.untilAdvancing(
      3,
      async () => (await this.workspace()).git_ref.remote === ".",
    );
    await this.gitViewer.poll();
    await this.hover();
    await this.click();
    await this.untilAdvancing(
      3,
      async () => (await this.workspace()).git_ahead === 0,
    );
    this.assertEqual(
      await this.git("rev-parse", "HEAD"),
      await this.git("rev-parse", "local-upstream"),
    );
  }

  async test_switching_branches_cannot_join_an_old_push() {
    const base = await this.git("rev-parse", "origin/main");
    const expected = await this.git("rev-parse", "HEAD");
    await this.git("push", "origin", `${base}:refs/heads/second`);
    await this.git("branch", "second");
    await this.git("branch", "--set-upstream-to=origin/second", "second");
    const push = this.heldPush();
    await this.hover();
    await this.click();
    await this.until(push.started);
    await this.git("checkout", "second");
    await this.untilAdvancing(
      3,
      async () =>
        (await this.workspace()).git_ref.branch === "refs/heads/second",
    );
    await this.gitViewer.poll();
    this.assertEqual((await this.workspace()).git_push.phase, "idle");
    await this.click();
    this.assertIn("A push is already running", this.gitViewer.state.data);
    push.release();
    await this.until(
      async () =>
        (await this.git("--git-dir", this.remote, "rev-parse", "main")) ===
        expected,
    );
    this.assertEqual((await this.workspace()).git_push.phase, "idle");
    this.assertEqual(
      base,
      await this.git("--git-dir", this.remote, "rev-parse", "second"),
    );
  }
}

registerCase("GitPush", GitPush);
