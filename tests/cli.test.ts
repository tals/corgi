import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Runtime, EXE, layout_tree, Viewer } from "./runtime";
import { registerCase, run } from "./support";

class AgentCli extends Runtime {
  async cli(
    args: any[],
    {
      caller,
      error,
      stdin,
    }: { caller?: number; error?: string; stdin?: string } = {},
  ) {
    const env = { ...this.env };
    delete env.CORGI_PANE;
    if (caller !== undefined) env.CORGI_PANE = String(caller);
    const p = await run([EXE, ...args.map(String)], {
      env,
      input: stdin,
      check: false,
    });
    if (error !== undefined) {
      this.assertNotEqual(p.code, 0, p.stdout);
      this.assertEqual(JSON.parse(p.stderr).err, error);
      this.assertEqual(p.stdout, "");
      return p.code;
    }
    this.assertEqual(p.code, 0, [args, p.stderr, p.stdout]);
    return JSON.parse(p.stdout);
  }
  async new(name = "tab", workspace = 1) {
    return (
      await this.cli(["tab", "new", "--name", name, "--workspace", workspace])
    ).result;
  }
  async snapshot() {
    return (await this.cli(["list"])).result;
  }
  async topology() {
    return (await this.snapshot()).workspaces.map((w: any) => [
      w.id,
      w.model.tabs,
    ]);
  }
  async test_layout_moves_keep_processes_and_tree() {
    const one = await this.new("one"),
      two = await this.new("two");
    const split = (await this.cli(["pane", "split", one.pane, "--down"]))
      .result;
    const before = await this.snapshot(),
      sourceTree = layout_tree(before.workspaces[0]);
    const pids = Object.fromEntries(
      before.panes.map((p: any) => [p.id, p.pid]),
    );
    await this.cli(["tab", "rename", one.tab, "Backend"]);
    await this.cli(["tab", "move", one.tab, "--after", two.tab]);
    this.assertEqual(
      (await this.snapshot()).workspaces[0].model.tabs.map((t: any) => t.id),
      [two.tab, one.tab],
    );
    await this.cli(["tab", "merge", one.tab, "--right-of", two.pane]);
    this.assertEqual(
      (await this.snapshot()).workspaces[0].model.tabs.length,
      1,
    );
    this.assertEqual(
      layout_tree((await this.snapshot()).workspaces[0]).split.second,
      sourceTree,
    );
    const detached = (
      await this.cli([
        "pane",
        "move",
        split.pane,
        "--new-tab",
        "--name",
        "Logs",
      ])
    ).result;
    this.assertNotEqual(detached.tab, one.tab);
    await this.cli(["pane", "move", split.pane, "--above", one.pane]);
    await this.cli(["pane", "swap", split.pane, two.pane]);
    this.assertEqual(
      Object.fromEntries(
        (await this.snapshot()).panes.map((p: any) => [p.id, p.pid]),
      ),
      pids,
    );
    for (const pid of Object.values(pids)) process.kill(pid as number, 0);
  }
  async test_cross_workspace_current_and_atomic_failures() {
    const one = await this.new(),
      split = (await this.cli(["pane", "split", one.pane, "--left"])).result;
    const ws = (
      await this.command("workspace.create", {
        name: "other",
        cwd: this.temp.name,
      })
    ).workspace;
    await this.cli(["tab", "move", one.tab, "--workspace", ws]);
    const here = (await this.cli(["current"], { caller: split.pane })).result;
    this.assertEqual(here.workspace, ws);
    this.assertEqual(here.tab, one.tab);
    await this.cli(["tab", "rename", "current", "Moved"], {
      caller: split.pane,
    });
    const two = await this.new("destination");
    await this.cli(["pane", "move", "current", "--below", two.pane], {
      caller: split.pane,
    });
    this.assertEqual(
      (await this.cli(["current"], { caller: split.pane })).result.workspace,
      1,
    );
    const before = await this.topology();
    await this.cli(["tab", "merge", two.tab, "--right-of", split.pane], {
      error: "InvalidDestination",
    });
    await this.cli(["pane", "move", one.pane, "--right-of", 999999], {
      error: "NoPane",
    });
    await this.cli(["pane", "resize", one.pane, "--width", "60%"], {
      error: "NoSplit",
    });
    this.assertEqual(await this.topology(), before);
    await this.cli(["pane", "swap", one.pane, two.pane]);
    this.assertEqual(
      (await this.cli(["current"], { caller: one.pane })).result.workspace,
      1,
    );
    this.assertEqual(
      (await this.cli(["current"], { caller: two.pane })).result.workspace,
      ws,
    );
  }
  async test_split_resize_and_close() {
    const one = await this.new(),
      split = (await this.cli(["pane", "split", one.pane, "--left"])).result;
    this.assertEqual(
      layout_tree((await this.snapshot()).workspaces[0]).split.first.pane,
      split.pane,
    );
    await this.cli(["pane", "resize", one.pane, "--width", "60%"]);
    this.assertEqual(
      layout_tree((await this.snapshot()).workspaces[0]).split.ratio,
      400,
    );
    await this.cli(["pane", "close", split.pane]);
    this.assertEqual((await this.snapshot()).panes.length, 1);
    await this.cli(["tab", "close", one.tab]);
    this.assertEqual((await this.snapshot()).panes, []);
  }
  async test_docs_show_the_current_shortcuts() {
    const table = (await run([EXE, "keys"])).stdout;
    this.assertIn("| New tab (agent picker) |", table);
    const reference = readFileSync(
      join(import.meta.dir, "../docs/reference.md"),
      "utf8",
    );
    this.assertIn(
      table,
      reference,
      "docs/reference.md is stale: paste in the table `corgi keys` prints",
    );
  }
  async test_discovery_errors_and_terminal_io() {
    for (const args of [
      ["--help"],
      ["--skill"],
      ["tab"],
      ["pane"],
      ["pane", "move", "--help"],
    ])
      await run([EXE, ...args], {
        env: { ...this.env, CORGI_SOCKET: this.temp.name + "/absent.sock" },
      });
    this.assertIn("Otherwise run: corgi --skill", await this.run_cli("--help"));
    this.assertEqual(
      await this.cli(["pane", "split", "current", "--right"], {
        error: "NoCallerPane",
      }),
      2,
    );
    await this.cli(["tab", "new"], { error: "MissingWorkspace" });
    const one = await this.new();
    await this.cli(["pane", "send", one.pane, "--stdin", "--enter"], {
      stdin: "printf 'cli_marker_123\\n'",
    });
    await this.until(async () =>
      (await this.cli(["pane", "read", one.pane])).result.text.includes(
        "cli_marker_123",
      ),
    );
    await this.cli(["pane", "keys", one.pane, "ctrl+c"]);
    await this.cli(["pane", "keys", one.pane, "enter", "invalid-key"], {
      error: "InvalidKey",
    });
    await this.cli(["focus", one.pane, "--viewer", 999], { error: "NoViewer" });
  }
  async test_viewers_keep_selection_and_explicit_focus() {
    const one = await this.new("one"),
      two = await this.new("two");
    const left = await Viewer.create(this),
      right = await Viewer.create(this);
    await left.focus(one.pane);
    await right.focus(two.pane);
    const before = (await this.cli(["list"])).viewers;
    await this.cli(["tab", "rename", one.tab, "renamed"]);
    await this.cli(["tab", "move", one.tab, "--after", two.tab]);
    await this.cli(["pane", "split", one.pane, "--down"]);
    await left.poll();
    await right.poll();
    this.assertEqual((await this.cli(["list"])).viewers, before);
    const viewerId = before.find((v: any) => v.pane === one.pane).id;
    await this.cli(["focus", two.pane, "--viewer", viewerId]);
    await left.poll();
    await right.poll();
    this.assertTrue(
      (await this.cli(["list"])).viewers.every((v: any) => v.pane === two.pane),
    );
  }
  async test_cwd_and_scrollback() {
    const path = join(this.temp.name, "project");
    mkdirSync(path);
    const folder = realpathSync(path);
    const one = (
      await this.cli(["tab", "new", "--workspace", 1, "--cwd", folder])
    ).result;
    const split = (
      await this.cli(["pane", "split", "current", "--up"], { caller: one.pane })
    ).result;
    this.assertEqual(
      (await this.snapshot()).panes.find((p: any) => p.id === split.pane).cwd,
      folder,
    );
    const pane = (await this.cli(["tab", "new"], { caller: split.pane }))
      .result;
    this.assertEqual(
      (await this.snapshot()).panes.find((p: any) => p.id === pane.pane).cwd,
      folder,
    );
    await this.cli([
      "pane",
      "send",
      one.pane,
      "i=0; while [ $i -lt 150 ]; do printf 'row_%03d\\n' $i; i=$((i+1)); done",
      "--enter",
    ]);
    await this.until(async () =>
      (
        await this.cli(["pane", "read", one.pane, "--lines", 10])
      ).result.text.includes("row_149"),
    );
    const recent = (await this.cli(["pane", "read", one.pane, "--lines", 100]))
      .result.text;
    this.assertIn("row_080", recent);
    this.assertNotIn("row_000", recent);
    this.assertLessEqual(recent.trimEnd().split("\n").length, 100);
    this.assertEqual(
      (
        await this.raw_rpc({
          op: "session.command",
          protocol: 1,
          command: { "pane.move": { target: one.pane } },
        })
      ).err,
      "MissingField",
    );
  }
  async test_command_options_launch_processes() {
    const one = (
      await this.cli([
        "tab",
        "new",
        "--workspace",
        1,
        "--command",
        "printf 'TAB_COMMAND_OK\\n'; exec /bin/sh",
      ])
    ).result;
    const two = (
      await this.cli([
        "pane",
        "split",
        one.pane,
        "--down",
        "--command",
        "printf 'SPLIT_COMMAND_OK\\n'; exec /bin/sh",
      ])
    ).result;
    await this.until(async () =>
      (await this.cli(["pane", "read", one.pane])).result.text.includes(
        "TAB_COMMAND_OK",
      ),
    );
    await this.until(async () =>
      (await this.cli(["pane", "read", two.pane])).result.text.includes(
        "SPLIT_COMMAND_OK",
      ),
    );
  }
  async test_workspace_commands_share_validation_and_error_output() {
    const created = (
        await this.cli(["workspace", "new", "Project", "--cwd", this.temp.name])
      ).result,
      workspace = created.workspace;
    await this.cli(["workspace", "edit", workspace, "--name", "Renamed"]);
    this.assertEqual(
      (await this.cli(["workspace", "list"])).result.workspaces.find(
        (w: any) => w.id === workspace,
      ).name,
      "Renamed",
    );
    const before = (await this.snapshot()).workspaces;
    this.assertEqual(
      await this.cli(
        ["workspace", "close", workspace, "--cwd", this.temp.name],
        { error: "Usage" },
      ),
      2,
    );
    this.assertEqual((await this.snapshot()).workspaces, before);
    await this.cli(["workspace", "close", workspace], {
      error: "WorkspaceNotEmpty",
    });
    await this.cli(["workspace", "switch", workspace], { error: "NoViewer" });
    await this.cli(["pane", "close", created.pane]);
    await this.cli(["workspace", "close", workspace]);
    this.assertNotIn(
      workspace,
      (await this.snapshot()).workspaces.map((w: any) => w.id),
    );
  }
  async test_daemon_has_no_implicit_focus_or_geometry() {
    const one = await this.new(),
      two = await this.new(),
      before = await this.snapshot();
    for (const request of [
      { op: "focus", pane: one.pane },
      { op: "action", name: "next" },
      { op: "workspace.switch", workspace: 1 },
    ])
      this.assertEqual((await this.raw_rpc(request)).err, "NoViewer");
    this.assertEqual((await this.snapshot()).workspaces, before.workspaces);
    this.assertEqual(
      (
        await this.raw_rpc({
          op: "session.command",
          command: { "workspace.create": { cwd: this.temp.name } },
          protocol: 2,
        })
      ).err,
      "UnsupportedProtocol",
    );
    const split = (await this.cli(["pane", "split", one.pane, "--right"]))
      .result;
    this.assertEqual(
      new Set(
        (await this.snapshot()).panes.map((p: any) =>
          JSON.stringify([p.cols, p.rows]),
        ),
      ),
      new Set(["[80,24]"]),
    );
    this.assertEqual(
      (await this.cli(["current"], { caller: two.pane })).result.pane,
      two.pane,
    );
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.temp.name,
      })
    ).workspace;
    this.assertEqual(
      (
        await this.raw_rpc({
          op: "session.command",
          protocol: 1,
          command: { "pane.create": {} },
        })
      ).err,
      "MissingField",
    );
    await this.cli(["tab", "new", "--workspace", other], { caller: one.pane });
    this.assertIn(
      split.pane,
      (await this.snapshot()).panes.map((p: any) => p.id),
    );
  }
  async test_workspace_preference_is_for_attachment_only() {
    const one = await this.new(),
      ws = (
        await this.command("workspace.create", {
          name: "Other",
          cwd: this.temp.name,
        })
      ).workspace;
    const viewer = await Viewer.create(this);
    await viewer.request({ op: "workspace", workspace: ws });
    await viewer.close();
    this.assertEqual(
      (
        await this.raw_rpc({
          op: "session.command",
          protocol: 1,
          command: { "pane.create": {} },
        })
      ).err,
      "MissingField",
    );
    await this.restart_runtime();
    const reopened = await Viewer.create(this);
    this.assertEqual(reopened.state.workspace, ws);
    this.assertNotEqual(reopened.state.pane, one.pane);
  }
}
registerCase("AgentCli", AgentCli, { inherited: false });
