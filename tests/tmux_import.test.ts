import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { registerCase, TestCase, run, quote, sleep } from "./support";
import { screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { ImportFixture } from "./import_fixture";

const TMUX = Bun.which("tmux");
const TIG = Bun.which("tig");

class TmuxImport extends TestCase {
  // Suggested commands need an editable prompt before Return is pressed.
  shell = "/bin/bash";
  fixture!: ImportFixture;
  tmuxBase!: string[];
  left!: string;
  bottom!: string;
  savedLayout!: string;

  async setUp() {
    this.fixture = new ImportFixture();
    this.fixture.env.SHELL = this.shell;
    const root = this.fixture.root;
    for (const name of ["left", "top", "bottom"]) mkdirSync(join(root, name));
    symlinkSync(TMUX!, join(root, "bin/tmux"));
    if (TIG) symlinkSync(TIG, join(root, "bin/tig"));
    this.fixture.env.TMUX_TMPDIR = root;
    this.tmuxBase = [TMUX!, "-S", join(root, "tmux.sock"), "-f", "/dev/null"];
    await this.tmux(
      "new-session",
      "-d",
      "-s",
      "tmux-fixture",
      "-n",
      "nested",
      "-x",
      "120",
      "-y",
      "40",
      "-c",
      join(root, "left"),
      "/bin/sleep 120",
    );
    this.left = await this.tmux("display-message", "-p", "-t", "tmux-fixture:0", "#{pane_id}");
    const top = await this.tmux(
      "split-window",
      "-h",
      "-d",
      "-l",
      "60",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      this.left,
      "-c",
      join(root, "top"),
      "/bin/sleep 120",
    );
    this.bottom = await this.tmux(
      "split-window",
      "-v",
      "-d",
      "-l",
      "20",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      top,
      "-c",
      join(root, "bottom"),
      "/bin/sleep 120",
    );
    this.savedLayout = await this.tmux("display-message", "-p", "-t", "tmux-fixture:0", "#{window_layout}");
    this.fixture.env.TMUX = join(root, "tmux.sock") + ",0,0";
    await this.fixture.start();
  }

  async tearDown() {
    try {
      await this.fixture.close();
    } finally {
      await run([...this.tmuxBase, "kill-server"], {
        env: this.fixture.env,
        check: false,
      });
    }
  }

  async tmux(...args: string[]) {
    return (await run([...this.tmuxBase, ...args], { env: this.fixture.env })).stdout.trim();
  }

  async checkImport(zoomedPane?: string) {
    if (zoomedPane) await this.tmux("resize-pane", "-Z", "-t", zoomedPane);
    const listArgs = [
      "list-panes",
      "-t",
      "tmux-fixture:0",
      "-F",
      "#{pane_id} #{pane_pid} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
    ];
    const before = await this.tmux(...listArgs);
    const v = await Viewer.create(this.fixture, 100, 34);
    await v.input("\r");
    await v.input("1");
    const text = async () => screen_text((await v.poll()).data, 100, 34).join("\n");
    await this.fixture.until(async () => (await text()).includes("tmux-fixture"));
    this.assertIn("[x] tmux-fixture", await text());
    await v.input("\r");
    await this.fixture.until(async () => (await text()).includes("You're ready to go"));
    const snapshot = await this.fixture.rpc({ op: "session.snapshot" });
    const ws = snapshot.workspaces.find((w: any) => w.name === "tmux-fixture");
    this.assertEqual(ws.model.tabs.length, 1);
    const tab = ws.model.tabs[0];
    this.assertEqual(tab.title, "nested");
    const panes = Object.fromEntries(
      snapshot.panes.filter((p: any) => p.workspace === ws.id).map((p: any) => [p.id, p]),
    );
    this.assertEqual(Object.keys(panes).length, 3);
    this.assertTrue(Object.values(panes).every((p: any) => p.pid > 0));
    const shape = (index: number): any => {
      const node = ws.model.nodes[index];
      if ("pane" in node) return basename((panes as any)[node.pane].cwd);
      const split = node.split;
      return [split.axis, split.ratio, shape(split.first), shape(split.second)];
    };
    this.assertEqual(shape(tab.root), ["horizontal", 500, "left", ["vertical", 500, "top", "bottom"]]);
    this.assertEqual(
      await this.tmux("display-message", "-p", "-t", "tmux-fixture:0", "#{window_zoomed_flag}"),
      zoomedPane ? "1" : "0",
    );
    this.assertEqual(
      await this.tmux("display-message", "-p", "-t", "tmux-fixture:0", "#{window_layout}"),
      this.savedLayout,
    );
    this.assertEqual(await this.tmux(...listArgs), before);
  }

  async test_unzoomed_window() {
    await this.checkImport();
  }
  async test_collapsed_workspace_expands_and_imports_hidden_terminals() {
    for (let i = 1; i <= 5; i++) {
      await this.tmux("new-window", "-d", "-t", "tmux-fixture", "-n", `extra-${i}`, "/bin/sleep 120");
    }
    const v = await Viewer.create(this.fixture, 76, 26);
    await v.input("\r1");
    const rows = async () => screen_text((await v.poll()).data, 76, 26);
    const text = async () => (await rows()).join("\n");
    const click = async (label: string) => {
      const screen = await rows();
      const y = screen.findIndex(row => row.includes(label));
      this.assertTrue(y >= 0, `Missing ${label}`);
      const x = [...screen[y].slice(0, screen[y].indexOf(label))].length;
      await v.input(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    };
    await this.fixture.until(async () => (await text()).includes("…5 more"));
    this.assertIn("[x] tmux-fixture", await text());
    this.assertNotIn("extra-1", await text());
    await click("…5 more");
    this.assertIn("Show less", await text());
    this.assertIn("extra-1", await text());
    this.assertIn("[x] tmux-fixture", await text());
    await click("Show less");
    this.assertIn("…5 more", await text());
    await v.input("e");
    this.assertIn("Show less", await text());
    await v.input("E");
    this.assertIn("…5 more", await text());
    await v.input("\r");
    await this.fixture.until(async () => (await text()).includes("You're ready to go"));
    const snapshot = await this.fixture.rpc({ op: "session.snapshot" });
    const ws = snapshot.workspaces.find((w: any) => w.name === "tmux-fixture");
    this.assertEqual(ws.model.tabs.length, 6);
    this.assertEqual(snapshot.panes.filter((p: any) => p.workspace === ws.id).length, 8);
    this.assertEqual((await this.tmux("list-panes", "-s", "-t", "tmux-fixture")).split("\n").length, 8);
  }
  async test_zoomed_first_pane_imports_all_splits_without_changing_source() {
    await this.checkImport(this.left);
  }
  async test_zoomed_nested_pane_imports_all_splits_without_changing_source() {
    await this.checkImport(this.bottom);
  }

  async command(operation: string, payload: object) {
    return (
      await this.fixture.rpc({
        op: "session.command",
        command: { [operation]: payload },
      })
    ).result;
  }

  async importSelected() {
    const viewer = await Viewer.create(this.fixture, 100, 34);
    await viewer.input("\r1");
    const text = async () => screen_text((await viewer.poll()).data, 100, 34).join("\n");
    await this.fixture.until(async () => (await text()).includes("[x] tmux-fixture"));
    await viewer.input("\r");
    await this.fixture.until(async () => (await text()).includes("You're ready to go"));
    await viewer.input("\r");
    const snapshot = await this.fixture.rpc({ op: "session.snapshot" });
    const workspace = snapshot.workspaces.find((w: any) => w.name === "tmux-fixture");
    return {
      viewer,
      panes: snapshot.panes.filter((p: any) => p.workspace === workspace.id),
    };
  }

  async test_scrollback_and_quoted_command_wait_for_return() {
    // tee opens this path only when it starts, making early execution observable.
    const file = join(this.fixture.root, "a b'c\\d$(not-a-command)");
    await this.tmux("respawn-pane", "-k", "-t", this.left, "/bin/bash --noprofile --norc");
    await this.tmux(
      "send-keys",
      "-t",
      this.left,
      "-l",
      `i=0; while [ $i -lt 160 ]; do printf 'BACKSCROLL_%s\\n' \"$i\"; i=$((i+1)); done; /usr/bin/tee ${quote(file)}`,
    );
    await this.tmux("send-keys", "-t", this.left, "Enter");
    await this.fixture.until(() => existsSync(file));
    unlinkSync(file);
    const { panes } = await this.importSelected();
    const pane = panes.find((p: any) => basename(p.cwd) === "left");
    const history = async () => (await this.command("pane.read", { target: pane.id, lines: 1000 })).text;
    await this.fixture.until(async () => {
      const text = await history();
      return text.lastIndexOf("/usr/bin/tee") > text.indexOf("# Press Return to restart");
    });
    this.assertIn("BACKSCROLL_0", await history());
    this.assertIn("BACKSCROLL_159", await history());
    await sleep(0.15);
    this.assertFalse(existsSync(file), "import must not execute the suggested command");
    await this.command("pane.input", { target: pane.id, data: "\r" });
    await this.fixture.until(() => existsSync(file));
    await this.command("pane.input", { target: pane.id, data: "RESTARTED\n" });
    await this.fixture.until(() => readFileSync(file, "utf8").includes("RESTARTED"));
  }

  async test_two_tig_panes_restore_context_and_restart_independently() {
    const cwd = join(this.fixture.root, "left");
    // Keep the commit title visible in both narrow source panes.
    writeFileSync(
      join(this.fixture.env.HOME, ".tigrc"),
      "set main-view = line-number:no id:no date:no author:no commit-title:yes,graph,refs,overflow=no\n",
    );
    await run(["git", "init", cwd], { env: this.fixture.env });
    await run(
      [
        "git",
        "-C",
        cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "IMPORTED_TIG_COMMIT",
      ],
      { env: this.fixture.env },
    );
    for (const pane of [this.left, this.bottom]) {
      await this.tmux("respawn-pane", "-k", "-t", pane, "-c", cwd, "/bin/bash --noprofile --norc");
      await this.tmux(
        "send-keys",
        "-t",
        pane,
        "-l",
        "i=0; while [ $i -lt 160 ]; do printf 'TIG_SCROLLBACK_%s\\n' \"$i\"; i=$((i+1)); done; printf 'SHELL_CONTEXT_BEFORE_TIG\\n'; tig --all",
      );
      await this.tmux("send-keys", "-t", pane, "Enter");
      await this.fixture
        .until(async () => (await this.tmux("capture-pane", "-p", "-t", pane)).includes("IMPORTED_TIG_COMMIT"))
        .catch(async error => {
          throw new Error(`${error}\n${await this.tmux("capture-pane", "-p", "-t", pane)}`);
        });
    }
    const source = await this.tmux(
      "list-panes",
      "-t",
      "tmux-fixture:0",
      "-F",
      "#{pane_id} #{pane_pid} #{pane_current_command}",
    );
    const { panes } = await this.importSelected();
    const imported = panes.filter((p: any) => basename(p.cwd) === "left");
    this.assertEqual(imported.length, 2);
    const foreground = async (pid: number) => (await run(["ps", "-p", String(pid), "-o", "tpgid="])).stdout.trim();
    for (const pane of imported) {
      const history = async () => (await this.command("pane.read", { target: pane.id, lines: 1000 })).text;
      await this.fixture.until(async () => {
        const text = await history();
        return text.lastIndexOf("tig --all") > text.indexOf("# Press Return to restart");
      });
      this.assertIn("SHELL_CONTEXT_BEFORE_TIG", await history());
      this.assertIn("IMPORTED_TIG_COMMIT", await history());
      const text = await history();
      this.assertIn("TIG_SCROLLBACK_0", text);
      this.assertTrue(text.indexOf("TIG_SCROLLBACK_0") < text.lastIndexOf("SHELL_CONTEXT_BEFORE_TIG"));
      this.assertTrue(text.lastIndexOf("SHELL_CONTEXT_BEFORE_TIG") < text.indexOf("IMPORTED_TIG_COMMIT"));
      this.assertEqual(await foreground(pane.pid), String(pane.pid));
      await this.command("pane.input", { target: pane.id, data: "\r" });
      await this.fixture.until(async () => (await foreground(pane.pid)) !== String(pane.pid));
      const job = await foreground(pane.pid);
      this.assertIn("tig", (await run(["ps", "-p", job, "-o", "comm="])).stdout);
    }
    this.assertEqual(
      await this.tmux("list-panes", "-t", "tmux-fixture:0", "-F", "#{pane_id} #{pane_pid} #{pane_current_command}"),
      source,
    );
  }

  async test_only_three_latest_groups_are_checked() {
    for (const name of ["recent-a", "recent-b", "recent-c"]) {
      await sleep(1.05); // tmux records session activity in whole seconds.
      await this.tmux("new-session", "-d", "-s", name, "/bin/sleep 120");
    }
    const viewer = await Viewer.create(this.fixture, 100, 34);
    await viewer.input("\r1");
    const text = async () => screen_text((await viewer.poll()).data, 100, 34).join("\n");
    await this.fixture.until(async () => (await text()).includes("[x] recent-c"));
    await viewer.input("\r");
    await this.fixture.until(async () => (await text()).includes("You're ready to go"));
    const snapshot = await this.fixture.rpc({ op: "session.snapshot" });
    const names = snapshot.workspaces.map((w: any) => w.name);
    this.assertFalse(names.includes("tmux-fixture"));
    this.assertEqual(
      names.filter((name: string) => name.startsWith("recent-")),
      ["recent-c", "recent-b", "recent-a"],
    );
  }
}

registerCase("tmux import", TmuxImport, {
  skip: !TMUX ? "tmux is required" : undefined,
  skipTests: !TIG
    ? {
        test_two_tig_panes_restore_context_and_restart_independently: "tig is required",
      }
    : {},
});

for (const name of ["fish", "zsh"]) {
  const executable = Bun.which(name);
  class ShellImport extends TmuxImport {
    shell = executable!;
    async test_scrollback_and_quoted_command_wait_for_return() {
      await super.test_scrollback_and_quoted_command_wait_for_return();
    }
  }
  registerCase(`tmux import into ${name}`, ShellImport, {
    inherited: false,
    skip: !TMUX || !executable,
  });
}
