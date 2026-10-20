/** Real viewer launch controls and read-only agent previews. */
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerCase, writeExecutable, shellJoin, quote, sleep, EXE, ROOT, JsonSocket } from "./support";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";

function json(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}
function content(path: string) {
  return readFileSync(path, "utf8");
}
function lines(path: string) {
  return content(path).trim().split("\n");
}
/** An account's usage windows as [minutes, used] pairs. */
function windows(info: any): unknown {
  return info.limits.windows?.map((w: any) => w && [w.minutes, w.used]);
}
const claudeWindows = [
  [300, 12],
  [10080, 48],
];
function hasLimits(row: string, short: number, weekly: number): boolean {
  return new RegExp(String.raw`\b5h(?:\s+━+)?\s+${short}%.*\b7d(?:\s+━+)?\s+${weekly}%`).test(row);
}

class Launcher extends Runtime {
  launches!: string;
  ws!: number;
  launchDir!: string;

  async configure() {
    const root = this.temp.name;
    this.env.CORGI_CLAUDE_BIN = join(root, "claude-metadata");
    this.env.CORGI_CLAUDE_TEST_LAUNCHES = join(root, "launches.jsonl");
    mkdirSync(join(this.env.CLAUDE_CONFIG_DIR!, "projects"), { recursive: true });
    writeFileSync(join(this.env.CLAUDE_CONFIG_DIR!, "metadata.json"), "{}");
    writeExecutable(
      this.env.CORGI_CLAUDE_BIN!,
      `await import(${JSON.stringify(join(ROOT, "tests/claude_metadata.ts"))});`,
    );
  }

  async setUp() {
    await super.setUp();
    writeFileSync(this.path + ".viewer.json", JSON.stringify({ onboarding_complete: true }));
    this.launches = join(this.temp.name, "launches.jsonl");
    const harness = join(ROOT, "tests/inference_harness.ts");
    writeExecutable(
      this.env.CORGI_CODEX_BIN!,
      `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('app-server')) { const p = Bun.spawn([process.execPath, ${JSON.stringify(harness)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }); process.exit(await p.exited); }
if (args.includes('--version')) { console.log('codex fixture'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') throw new Error('background preview must not invoke auth status');
appendFileSync(${JSON.stringify(this.launches)}, JSON.stringify({cwd:process.cwd(),args}) + '\\n');
if (args.at(-1) === 'refused') { console.log('That session is running in the background.'); process.exit(1); }
if (args.at(-1) === 'quits') process.exit(0);
console.log('LAUNCH FIXTURE READY'); await Bun.sleep(120000);
`,
    );
    const settings = join(this.env.CLAUDE_CONFIG_DIR!, "settings.json");
    const data = existsSync(settings) ? json(settings) : {};
    data.model = "opus";
    writeFileSync(settings, JSON.stringify(data));
    this.ws = (await this.session()).workspaces[0].id;
    mkdirSync(join(this.temp.name, "work"));
    this.launchDir = realpathSync(join(this.temp.name, "work"));
    await this.command("workspace.edit", {
      target: this.ws,
      cwd: this.launchDir,
    });
    await this.command("pane.create", {
      workspace: this.ws,
      cwd: this.launchDir,
      command: "sleep 120",
    });
  }
  clickViewer(viewer: Viewer, x: number, y: number) {
    return viewer.input(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
  }
  async clickText(view: Viewer, label: string, cols = 120) {
    const rows = screen_text((await view.poll()).data, cols, 30);
    const y = rows.findIndex(row => row.includes(label));
    this.assertGreaterEqual(y, 0, `missing ${label}`);
    return this.clickViewer(view, rows[y].indexOf(label) + 1, y + 1);
  }
  async assertSelected(view: Viewer, label: string, cols = 120) {
    const rows = screen_text((await view.poll()).data, cols, 30);
    this.assertTrue(
      rows.some(row => new RegExp("› +([0-9t→] +)?" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(row)),
      rows.join("\n"),
    );
  }
  async managerAction(view: Viewer, name: string, action: string) {
    const rows = screen_text((await view.poll()).data, 120, 30);
    const y = rows.findLastIndex(row => row.includes(name) && row.includes("[Edit]"));
    this.assertGreaterEqual(y, 0);
    return this.clickViewer(view, rows[y].indexOf(action) + 1, y + 1);
  }
  async waitSaved(index: number, source: string) {
    await this.until(async () => {
      if (this.viewers.length) await this.viewers.at(-1)!.poll();
      return (await this.session()).agent_commands[index].command === source;
    });
  }

  async test_manage_hide_add_edit_and_reload() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.clickText(view, "Manage agents");
    await this.clickText(view, "Codex");
    this.assertEqual((await this.session()).agent_hidden, {
      codex: true,
      claude: false,
    });
    await this.clickText(view, "Paste a command");
    const source = "FOO=123 claude code --whatever 'two words' --prompt '" + "x".repeat(100) + "'\n";
    await view.input("\x1b[200~" + source + "\x1b[201~");
    this.assertIn("Claude Code", (await view.poll()).data);
    await view.input("\r");
    await this.waitSaved(0, source.trim());
    this.assertFalse(existsSync(this.launches));
    this.assertEqual((await this.session()).agent_commands[0].command, source.trim());
    await this.managerAction(view, "Claude Code", "[✓]");
    this.assertTrue((await this.session()).agent_commands[0].hidden);
    await this.clickText(view, "[Done]");
    const rows = screen_text((await view.poll()).data, 120, 30);
    this.assertFalse(rows.some(row => row.includes("Codex")));
    this.assertEqual(rows.filter(row => row.includes("Claude Code")).length, 1);
    await this.clickText(view, "Manage agents");
    await this.managerAction(view, "Claude Code", "[ ]");
    await this.managerAction(view, "Claude Code", "[Edit]");
    const changed = "FOO=456 claude --model sonnet";
    await view.input("\x1b[200~" + changed + "\x1b[201~");
    await view.input("\r");
    await this.waitSaved(0, changed);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertEqual((await this.session()).agent_hidden, {
      codex: true,
      claude: false,
    });
    const entry = (await this.session()).agent_commands[0];
    this.assertEqual(entry.command, changed);
    this.assertFalse(entry.hidden);
    await this.managerAction(view, "Claude Code", "[✓]");
    await this.managerAction(view, "Claude Code", "[Edit]");
    await view.input("\x03\r");
    this.assertEqual((await this.session()).agent_commands[0].command, "");
    this.assertFalse((await this.session()).agent_commands[0].hidden);
    await this.clickText(view, "Paste a command");
    await view.input("replacement-agent\r");
    await this.waitSaved(0, "replacement-agent");
    this.assertFalse((await this.session()).agent_commands[0].hidden);
    await this.clickText(view, "[Done]");
    this.assertIn("Custom agent", (await view.poll()).data);
  }
  async test_manager_focus_inline_add_and_builtin_edit() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.clickText(view, "Manage agents");
    await view.input("FOO=123 claude --model sonnet");
    this.assertIn("FOO=123 claude --model sonnet", (await view.poll()).data);
    await this.clickText(view, "[Add]");
    await this.waitSaved(0, "FOO=123 claude --model sonnet");
    this.assertEqual((await this.session()).agent_commands[0].command.length, "FOO=123 claude --model sonnet".length);
    this.assertFalse(existsSync(this.launches));
    await this.managerAction(view, "Codex", "[Edit]");
    await view.input("codex --model example");
    await this.clickText(view, "[Save]");
    await this.waitSaved(1, "codex --model example");
    this.assertTrue((await this.session()).agent_hidden.codex);
    this.assertEqual((await this.session()).agent_commands[1].command, "codex --model example");
    this.assertIn("Paste a command", (await view.poll()).data);
    await view.input("abc");
    await view.input("\x1b[D");
    await view.input("X");
    this.assertIn("abXc", (await view.poll()).data);
    await view.input("\x1b");
    await this.until(async () => (await view.poll()).data.includes("New agent"));
  }
  async test_command_name_and_semantic_account_preview() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.clickText(view, "Manage agents");
    const source = "ANTHROPIC_API_KEY=fixture-secret claude --model sonnet --dangerously-skip-permissions";
    await view.input(source);
    await this.until(async () => (await view.poll()).data.includes("API key - identity unavailable"));
    this.assertIn("Skips permission checks", (await view.poll()).data);
    this.assertIn("Claude Code - Sonnet", (await view.poll()).data);
    await view.input("\tTeam assistant");
    await this.clickText(view, "[Add]");
    await this.waitSaved(0, source);
    const entry = (await this.session()).agent_commands[0];
    this.assertEqual(entry.name, "Team assistant");
    this.assertIn("Team assistant", (await view.poll()).data);
    await this.managerAction(view, "Team assistant", "[✓]");
    this.assertEqual((await this.session()).agent_commands[0].name, entry.name);
    await this.managerAction(view, "Team assistant", "[Edit]");
    await view.input("\tRenamed assistant\r");
    await this.until(async () => {
      await view.poll();
      return (await this.session()).agent_commands[0].name.startsWith("Renamed assistant");
    });
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertTrue((await this.session()).agent_commands[0].name.startsWith("Renamed assistant"));
  }
  async test_custom_agent_account_in_picker() {
    const config = join(this.temp.name, "work-profile");
    mkdirSync(config);
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
    await this.command("agent.command", {
      index: 0,
      command: `CLAUDE_CONFIG_DIR=${quote(config)} claude --dangerously-skip-permissions`,
      name: "Work",
    });
    const view = await Viewer.create(this, 160, 30);
    await view.input("\x02A");
    const rows = screen_text((await view.poll()).data, 160, 30);
    const row = rows.find(row => row.includes("Work") && row.includes("work@example.com"));
    this.assertIn("✓", row);
    this.assertIn("(cached)", row);
  }
  async test_signed_out_claude_is_hidden_but_manageable() {
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    writeFileSync(join(this.env.CLAUDE_CONFIG_DIR!, "metadata.json"), JSON.stringify({ loggedIn: false }));
    for (const key of Object.keys(this.env))
      if (
        key.startsWith("CLAUDE_CODE_USE_") ||
        ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"].includes(key)
      )
        delete this.env[key];
    await this.run_cli("start");
    const ws = (await this.session()).workspaces[0].id;
    const preview = async () =>
      (
        await this.rpc({
          op: "agent.preview",
          protocol: 1,
          workspace: ws,
          cwd: this.launchDir,
        })
      ).preview;
    await this.until(async () => !(await preview()).pending, 12);
    this.assertFalse((await preview()).options.claude.signed_in);
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.until(async () => !(await view.poll()).data.includes("Claude Code"));
    await view.input("\x1b");
    await view.input("\x02A");
    this.assertNotIn("Claude Code", (await view.poll()).data);
    await this.clickText(view, "Manage agents");
    this.assertIn("Not signed in", (await view.poll()).data);
  }
  async shellAliasCase(name: string) {
    const shell = Bun.which(name);
    if (!shell) return;
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    const root = this.temp.name,
      result = join(root, "shell-result.json"),
      script = join(root, "record-agent");
    writeExecutable(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(result)}, JSON.stringify({foo:process.env.FOO,args:process.argv.slice(2)}));`,
    );
    this.env.SHELL = shell;
    this.env.ZDOTDIR = root;
    this.env.XDG_CONFIG_HOME = join(root, ".config");
    let config: string;
    if (name === "fish") {
      config = join(root, ".config/fish/config.fish");
      mkdirSync(join(root, ".config/fish"), { recursive: true });
      writeFileSync(config, `function launchit\n ${quote(script)} --preset $argv\nend\nalias myagent launchit\n`);
    } else {
      config = join(root, name === "bash" ? ".bashrc" : ".zshrc");
      writeFileSync(config, `launchit() { ${quote(script)} --preset "$@"; }\nalias myagent='launchit --fixed'\n`);
    }
    await this.run_cli("start");
    const ws = (await this.session()).workspaces[0].id;
    const source = "FOO='123 with spaces' myagent --whatever 'two words'";
    await this.command("agent.command", { index: 0, command: source });
    this.assertFalse(existsSync(result));
    const saved = (await this.session()).agent_commands[0].command;
    this.assertNotIn("myagent", saved);
    this.assertNotIn("launchit", saved);
    writeFileSync(config, name === "fish" ? "function myagent\n echo WRONG\nend\n" : "alias myagent=false\n");
    await this.command("agent.command.create", {
      workspace: ws,
      cwd: this.launchDir,
      index: 0,
    });
    await this.until(() => existsSync(result));
    this.assertEqual(json(result), {
      foo: "123 with spaces",
      args: ["--preset", ...(name === "fish" ? [] : ["--fixed"]), "--whatever", "two words"],
    });
  }
  async test_bash_alias_and_inline_environment() {
    await this.shellAliasCase("bash");
  }
  async test_zsh_alias_and_inline_environment() {
    await this.shellAliasCase("zsh");
  }
  async test_fish_alias_and_inline_environment() {
    await this.shellAliasCase("fish");
  }
  async test_fish_cc_resolves_body_and_persists_claude_label() {
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    const root = this.temp.name;
    this.env.SHELL = Bun.which("fish") ?? "/opt/homebrew/bin/fish";
    this.env.XDG_CONFIG_HOME = join(root, ".config");
    const config = join(root, ".config/fish/config.fish");
    mkdirSync(join(root, ".config/fish"), { recursive: true });
    writeFileSync(
      config,
      "function cc --wraps=/stale/yesplz --wraps='claude --dangerously-skip-permissions'\n claude --allow-dangerously-skip-permissions --dangerously-skip-permissions $argv\nend\n",
    );
    await this.run_cli("start");
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.clickText(view, "Manage agents");
    await view.input("cc\r");
    const expanded = "command claude --allow-dangerously-skip-permissions --dangerously-skip-permissions";
    await this.waitSaved(0, expanded);
    const entry = (await this.session()).agent_commands[0];
    this.assertEqual(entry.command, expanded);
    this.assertIn("Claude Code", (await view.poll()).data);
    writeFileSync(config, "function cc\n false\nend\n");
    await this.managerAction(view, "Claude Code", "[✓]");
    await this.managerAction(view, "Claude Code", "[ ]");
    this.assertEqual((await this.session()).agent_commands[0].command, entry.command);
    this.assertFalse(existsSync(this.launches));
  }
  async test_debounced_preview_is_frozen_on_add_and_delete_is_inline() {
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    const root = this.temp.name;
    this.env.SHELL = Bun.which("fish") ?? "/opt/homebrew/bin/fish";
    this.env.XDG_CONFIG_HOME = join(root, ".config");
    const config = join(root, ".config/fish/config.fish");
    mkdirSync(join(root, ".config/fish"), { recursive: true });
    const log = join(root, "shell-starts"),
      prefix = `echo lookup >> ${quote(log)}\n`;
    writeFileSync(config, prefix + "alias cc 'claude --model original'\n");
    await this.run_cli("start");
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.clickText(view, "Manage agents");
    const baseline = existsSync(log) ? content(log) : "";
    // Continuous typing stays inside the debounce window.
    await view.input("cc");
    this.assertEqual(existsSync(log) ? content(log) : "", baseline);
    await this.until(async () => (await view.poll()).data.includes("[Show command]"));
    await this.clickText(view, "[Show command]");
    this.assertIn("command claude --model original", (await view.poll()).data);
    this.assertEqual((await this.session()).agent_commands[0].command, "");
    const before = content(log);
    writeFileSync(config, prefix + "alias cc 'claude --model changed'\n");
    await sleep(0.4);
    await view.poll();
    this.assertEqual(content(log), before);
    await this.clickText(view, "[Add]");
    await this.waitSaved(0, "command claude --model original");
    this.assertEqual(content(log), before);
    await this.managerAction(view, "Claude Code", "[Edit]");
    const rows = screen_text((await view.poll()).data, 120, 30);
    this.assertTrue(rows.some(row => row.includes("│ cc ")));
    this.assertNotIn("Runs:", (await view.poll()).data);
    await this.clickText(view, "[Show command]");
    this.assertIn("command claude --model original", (await view.poll()).data);
    await this.clickText(view, "[Cancel]");
    this.assertIn("Paste a command", (await view.poll()).data);
    await this.managerAction(view, "Claude Code", "[Edit]");
    await view.input("\tFrozen assistant");
    await this.clickText(view, "[Save]");
    await this.waitSaved(0, "command claude --model original");
    this.assertEqual(content(log), before);
    await this.managerAction(view, "Frozen assistant", "[Delete]");
    this.assertEqual((await this.session()).agent_commands[0].command, "");
    this.assertNotIn("[Delete]", (await view.poll()).data);
    this.assertFalse(existsSync(this.launches));
    writeFileSync(config, prefix + "sleep .3\nalias cc 'claude --model stale'\n");
    const previous = content(log);
    await view.input("cc");
    await this.until(async () => {
      await view.poll();
      return content(log) !== previous;
    });
    await view.input("\x15codex --model latest\r");
    await this.waitSaved(0, "codex --model latest");
    this.assertNotIn("stale", (await this.session()).agent_commands[0].command);
  }
  async test_preview_launch_last_choice_and_reload() {
    const view = await Viewer.create(this, 140, 30);
    this.assertIn("New", screen_text((await view.poll()).data, 140, 30)[14]);
    await this.clickViewer(view, 26, 15);
    await this.until(async () => (await view.poll()).data.includes("fixture-codex"), 12);
    const text = screen_text((await view.poll()).data, 140, 30).join("\n");
    for (const value of ["Claude Code", "Opus", "codex@example.com", "claude@example.com"]) this.assertIn(value, text);
    this.assertNotIn("User settings", text);
    const rows = screen_text((await view.poll()).data, 140, 30);
    this.assertTrue(
      rows.some(row => row.includes("Codex") && row.includes("fixture-codex") && row.includes("codex@example.com")),
    );
    this.assertTrue(
      rows.some(row => row.includes("Claude Code") && row.includes("Opus") && row.includes("claude@example.com")),
    );
    this.assertTrue(rows.some(row => row.includes("Codex") && row.includes("Pro 200") && hasLimits(row, 23, 61)));
    this.assertTrue(rows.some(row => row.includes("Claude Code") && row.includes("Max") && hasLimits(row, 12, 48)));
    this.assertFalse(existsSync(this.launches));
    this.assertEqual((await this.session()).panes.length, 1);
    const y = rows.findIndex(row => row.includes("Claude Code") && row.includes("Opus"));
    await this.clickViewer(view, rows[y].indexOf("Claude Code") + 1, y + 1);
    await this.until(() => existsSync(this.launches));
    this.assertEqual((await this.session()).last_agent, "claude");
    this.assertEqual((await this.session()).panes.length, 2);
    this.assertEqual(JSON.parse(lines(this.launches)[0]).cwd, this.launchDir);
    const other = await Viewer.create(this, 100, 30);
    await this.clickViewer(other, 20, 15);
    await this.until(() => lines(this.launches).length === 2);
    this.assertEqual((await this.session()).last_agent, "claude");
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertEqual((await this.session()).last_agent, "claude");
    await this.clickViewer(other, 26, 15);
    await other.input("k\r");
    await this.until(() => lines(this.launches).length === 3);
    this.assertEqual((await this.session()).last_agent, "codex");
  }
  async test_yolo_per_provider_toggle_launch_and_reload() {
    const view = await Viewer.create(this, 120, 30);
    await this.clickViewer(view, 26, 15);
    const rows = screen_text((await view.poll()).data, 120, 30);
    const y = rows.findIndex(row => row.includes("Codex"));
    await this.clickViewer(view, rows[y].indexOf("·") + 1, y + 1);
    this.assertEqual((await this.session()).agent_yolo, {
      codex: true,
      claude: false,
    });
    this.assertEqual((await this.session()).panes.length, 1);
    this.assertIn("New agent", (await view.poll()).data);
    await view.input("j");
    await view.input("y");
    this.assertEqual((await this.session()).agent_yolo, {
      codex: true,
      claude: true,
    });
    await view.input("y");
    this.assertEqual((await this.session()).agent_yolo, {
      codex: true,
      claude: false,
    });
    await view.input("k");
    await view.input("a");
    await this.until(() => existsSync(this.launches));
    this.assertIn("--dangerously-bypass-approvals-and-sandbox", JSON.parse(lines(this.launches)[0]).args);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertEqual((await this.session()).agent_yolo, {
      codex: true,
      claude: false,
    });
    await this.command("agent.yolo", { provider: "claude", enabled: true });
    await this.command("agent.create", {
      workspace: this.ws,
      provider: "claude",
    });
    await this.until(() => lines(this.launches).length === 2);
    this.assertIn("--dangerously-skip-permissions", JSON.parse(lines(this.launches)[1]).args);
    await this.command("agent.yolo", { provider: "codex", enabled: false });
    await this.command("agent.create", {
      workspace: this.ws,
      provider: "codex",
    });
    await this.until(() => lines(this.launches).length === 3);
    this.assertNotIn("--dangerously-bypass-approvals-and-sandbox", JSON.parse(lines(this.launches)[2]).args);
  }
  async test_hover_and_dismiss_do_not_launch() {
    const view = await Viewer.create(this, 80, 24);
    this.assertIn("New agent", (await view.input("\x1b[<35;21;12M")).data);
    this.assertEqual((await this.session()).panes.length, 1);
    await view.input("\x1b[<35;75;2M");
    await this.until(async () => !(await view.poll()).data.includes("New agent"));
    await this.clickViewer(view, 26, 12);
    this.assertIn("New agent", (await view.poll()).data);
    await this.clickViewer(view, 75, 2);
    this.assertNotIn("New agent", (await view.poll()).data);
    this.assertFalse(existsSync(this.launches));
  }
  async test_subscription_pushes_updates_and_survives_idle_reload() {
    const client = await JsonSocket.connect(this.path);
    try {
      client.send({
        op: "agent.subscribe",
        protocol: 1,
        workspace: this.ws,
        cwd: this.launchDir,
      });
      let initial = await client.read(12000);
      this.assertEqual(initial.type, "agent.preview");
      while (initial.preview.pending) initial = await client.read(12000);
      this.assertEqual(initial.cwd, this.launchDir);
      this.assertEqual(initial.preview.options.claude.model, "opus");
      await sleep(5.2);
      const settings = join(this.launchDir, ".claude/settings.json");
      mkdirSync(join(this.launchDir, ".claude"));
      writeFileSync(settings, JSON.stringify({ model: "sonnet" }));
      await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
      let update = await client.read(12000);
      while (update.preview.pending) {
        this.assertEqual(update.preview.options.claude.model, "opus");
        update = await client.read(12000);
      }
      this.assertEqual(update.preview.options.claude.model, "sonnet");
      const other = join(this.temp.name, "other");
      mkdirSync(other);
      client.send({
        op: "agent.subscribe",
        protocol: 1,
        workspace: this.ws,
        cwd: other,
      });
      update = await client.read(12000);
      while (update.preview.pending) update = await client.read(12000);
      this.assertEqual(update.cwd, other);
      this.assertEqual(update.preview.options.claude.model, "opus");
    } finally {
      client.close();
    }
  }
  async test_reopening_uses_pushed_preview_on_first_frame() {
    const view = await Viewer.create(this, 160, 30);
    await view.input("\x02A");
    await this.until(async () => (await view.poll()).data.includes("claude@example.com"), 12);
    await this.clickViewer(view, 158, 2);
    for (let i = 0; i < 3; i++) {
      const shown = await view.input("\x1b[<35;21;15M");
      this.assertIn("New agent", shown.data);
      this.assertNotIn("Reading", screen_text(shown.data, 160, 30).join("\n"));
      this.assertIn("fixture-codex", shown.data);
      this.assertIn("claude@example.com", shown.data);
      this.assertIn("12%", shown.data);
      this.assertNotIn("New agent", (await view.input("\x1b[<35;158;2M")).data);
    }
    const shown = await view.input("\x02A");
    this.assertNotIn("Reading", shown.data);
    this.assertIn("fixture-codex", shown.data);
    this.assertFalse(existsSync(this.launches));
  }
  async test_popup_arrows_tabs_escape_and_enter_own_keyboard() {
    const root = this.temp.name,
      keys = join(root, "keys"),
      ready = join(root, "ready"),
      script = join(root, "record-keys.ts");
    writeFileSync(
      script,
      `import { writeFileSync, openSync, writeSync } from 'node:fs';
writeFileSync(${JSON.stringify(ready)}, ''); const fd = openSync(${JSON.stringify(keys)}, 'w');
for await (const chunk of Bun.stdin.stream()) writeSync(fd, chunk);
`,
    );
    const pane = (
      await this.command("pane.create", {
        workspace: this.ws,
        cwd: this.launchDir,
        command: `stty raw -echo; ${shellJoin([process.execPath, script])}`,
      })
    ).pane;
    await this.until(() => existsSync(ready));
    const view = await Viewer.create(this, 100, 30);
    await view.focus(pane);
    await view.input("\x1b[<35;21;15M");
    await this.until(async () => (await view.poll()).data.includes("New agent"));
    await view.input("\x1b[B");
    await this.assertSelected(view, "Claude Code", 100);
    await view.input("\x1b[B");
    await this.assertSelected(view, "New terminal", 100);
    // Manage is the title's button; with no conversations below, down stops.
    await view.input("\x1b[B");
    await this.assertSelected(view, "New terminal", 100);
    await view.input("\x1b[A");
    await this.assertSelected(view, "Claude Code", 100);
    await view.input("\x1b[A");
    await this.assertSelected(view, "Codex", 100);
    await view.input("\x1b[A");
    await this.assertSelected(view, "Codex", 100);
    await view.input("\x1b[F");
    await this.assertSelected(view, "New terminal", 100);
    await view.input("\x1b[H");
    await this.assertSelected(view, "Codex", 100);
    await view.input("\x1b[Z");
    await this.assertSelected(view, "New terminal", 100);
    await view.input("\t");
    await this.assertSelected(view, "Codex", 100);
    await view.input("\x1b");
    await this.until(async () => !(await view.poll()).data.includes("New agent"));
    await sleep(0.6);
    this.assertNotIn("New agent", (await view.poll()).data);
    this.assertEqual(readFileSync(keys).length, 0);
    await view.input("\x1b[<35;98;2M");
    await view.input("\x1b[<35;21;15M");
    await this.until(async () => (await view.poll()).data.includes("New agent"));
    await this.clickViewer(view, 26, 15);
    await view.input("\x1bOB");
    await this.assertSelected(view, "Claude Code", 100);
    await view.input("\r");
    await this.until(() => existsSync(this.launches));
    this.assertEqual((await this.session()).last_agent, "claude");
    this.assertEqual(readFileSync(keys).length, 0);
  }
  async test_new_agent_shortcut_preview_then_launch() {
    const view = await Viewer.create(this, 100, 30);
    for (const [shortcut, launch] of [
      ["\x02A", "A"],
      ["\x02\x01", "\x01"],
      ["\x1b[98;5u\x1b[97;5u", "\x1b[97;5u"],
    ]) {
      const before = (await this.session()).panes.length;
      this.assertIn("New agent", (await view.input(shortcut)).data);
      this.assertEqual((await this.session()).panes.length, before);
      await view.input("\x1b[H");
      await view.input("\x1b[B");
      this.assertRegex((await view.poll()).data, / a \S* launch  \S* y \S* YOLO/);
      await view.input(launch);
      await this.until(async () => (await this.session()).panes.length === before + 1);
      this.assertEqual((await this.session()).last_agent, "claude");
    }
    await view.input("\x1b[<35;21;15M");
    this.assertIn("New agent", (await view.poll()).data);
    const before = (await this.session()).panes.length;
    await view.input("\x02A");
    this.assertEqual((await this.session()).panes.length, before);
    await view.input("A");
    await this.until(async () => (await this.session()).panes.length === before + 1);
  }
  async test_numbered_agent_shortcuts_follow_visible_rows() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    let rows = screen_text((await view.poll()).data, 120, 30);
    this.assertTrue(rows.some(row => /0 +Codex/.test(row)));
    this.assertTrue(rows.some(row => /1 +Claude Code/.test(row)));
    this.assertTrue(rows.some(row => /t +New terminal/.test(row)));
    let before = (await this.session()).panes.length;
    await view.input("1");
    await this.until(async () => (await this.session()).panes.length === before + 1);
    this.assertEqual((await this.session()).last_agent, "claude");
    await this.command("agent.visibility", {
      hidden: { codex: true, claude: false },
    });
    await this.command("agent.command", {
      index: 0,
      command: "sleep 120",
      name: "Custom sleeper",
      resolve: false,
    });
    await view.input("\x02A");
    rows = screen_text((await view.poll()).data, 120, 30);
    this.assertTrue(rows.some(row => /0 +Claude Code/.test(row)));
    this.assertTrue(rows.some(row => /1 +Custom sleeper/.test(row)));
    before = (await this.session()).panes.length;
    await view.input("9");
    this.assertEqual((await this.session()).panes.length, before);
    await view.input("1");
    await this.until(async () => (await this.session()).panes.length === before + 1);
    this.assertNotIn("New agent", (await view.poll()).data);
  }
  async test_selection_survives_dismiss_and_other_viewer_launch() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await view.input("\x1b[B");
    await view.input("\x1b");
    await view.input("\x02A");
    await this.assertSelected(view, "Claude Code");
    await this.clickText(view, "Manage agents");
    await view.input("\x1b");
    await this.until(async () => (await view.poll()).data.includes("New agent"));
    await this.assertSelected(view, "Claude Code");
    await view.input("\x1b");
    const before = (await this.session()).panes.length;
    const other = await Viewer.create(this, 120, 30);
    await other.input("\x02A");
    await other.input("0");
    await this.until(async () => {
      const session = await this.session();
      return session.last_agent === "codex" && session.panes.length === before + 1;
    });
    await view.input("\x02A");
    await this.assertSelected(view, "Claude Code");
    await view.input("\x1b");
    await view.input("\x1b[<35;118;2M");
    await view.input("\x1b[<35;21;15M");
    const rows = screen_text((await view.poll()).data, 120, 30);
    const y = rows.findIndex(row => row.includes("Codex"));
    await view.input(`\x1b[<35;${rows[y].indexOf("Codex") + 1};${y + 1}M`);
    await view.input("\x1b[<35;118;2M");
    this.assertNotIn("New agent", (await view.poll()).data);
    await view.input("\x02A");
    await this.assertSelected(view, "Codex");
  }
  async test_each_workspace_keeps_its_agent_and_new_ones_start_on_the_last() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await view.input("1");
    await this.until(async () => (await this.session()).workspaces[0].last_agent === "claude");
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.launchDir,
      })
    ).workspace;
    await view.poll();
    await view.request({ op: "workspace", workspace: other });
    await view.input("\x02A");
    await this.assertSelected(view, "Claude Code");
    await view.input("0");
    const workspace = async (id: number) => (await this.session()).workspaces.find((ws: any) => ws.id === id);
    await this.until(async () => (await workspace(other)).last_agent === "codex");
    this.assertEqual((await this.session()).last_agent, "codex");
    await view.request({ op: "workspace", workspace: this.ws });
    await view.input("\x02A");
    await this.assertSelected(view, "Claude Code");
    await view.input("\x1b");
    await this.until(async () => !(await view.poll()).data.includes("New agent"));
    await this.command("agent.create", { workspace: this.ws });
    this.assertEqual((await this.session()).last_agent, "claude");
    this.assertEqual((await workspace(other)).last_agent, "codex");
    await view.request({ op: "workspace", workspace: other });
    await view.input("\x02A");
    await this.assertSelected(view, "Codex");
  }
  async test_custom_selection_survives_launch_and_hidden_row_falls_back() {
    await this.command("agent.command", {
      index: 0,
      command: "sleep 120",
      name: "Custom sleeper",
      resolve: false,
    });
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await view.input("2");
    this.assertEqual((await this.session()).panes.length, 2);
    await view.input("\x02A");
    await this.assertSelected(view, "Custom sleeper");
    await this.clickViewer(view, 118, 2);
    await view.input("\x02A");
    await this.assertSelected(view, "Custom sleeper");
    await view.input("\x1b");
    await this.command("agent.command", {
      index: 0,
      command: "sleep 120",
      name: "Custom sleeper",
      hidden: true,
      resolve: false,
    });
    await view.input("\x02A");
    await this.assertSelected(view, "Codex");
    this.assertNotIn("Custom sleeper", (await view.poll()).data);
  }
  async test_new_terminal_row_opens_a_plain_tab() {
    const view = await Viewer.create(this, 100, 30);
    this.assertIn("New terminal", (await view.input("\x02A")).data);
    const before = (await this.session()).panes.length;
    await view.input("t");
    await this.until(async () => (await this.session()).panes.length === before + 1);
    this.assertNotIn("New agent", (await view.poll()).data);
    await view.input("\x02A");
    // A terminal is a detour: the launcher keeps the row from before it.
    await this.assertSelected(view, "Codex", 100);
    await view.input("\x1b[F");
    await this.assertSelected(view, "New terminal", 100);
    this.assertRegex((await view.poll()).data, / a \S* open/);
    await view.input("\r");
    await this.until(async () => (await this.session()).panes.length === before + 2);
    await view.input("\x02A");
    await view.input("\x02A");
    this.assertEqual((await this.session()).panes.length, before + 2);
    this.assertIn("New agent", (await view.poll()).data);
    await view.input("t");
    await this.until(async () => (await this.session()).panes.length === before + 3);
    this.assertNotIn("New agent", (await view.poll()).data);
    this.assertFalse(existsSync(this.launches));
  }
  async test_hover_accepts_launch_keys() {
    const view = await Viewer.create(this, 100, 30);
    for (const launch of ["a", "A", "\x01", "\x1b[97;5u"]) {
      await view.input("\x1b[<35;98;2M");
      this.assertIn("New agent", (await view.input("\x1b[<35;21;15M")).data);
      const before = (await this.session()).panes.length;
      await view.input(launch);
      await this.until(async () => (await this.session()).panes.length === before + 1);
      this.assertNotIn("New agent", (await view.poll()).data);
    }
  }
  async directoryPreview(name: string) {
    const directory = join(this.temp.name, name);
    mkdirSync(directory, { recursive: true });
    const preview = async () =>
      (await this.rpc({ op: "agent.preview", protocol: 1, workspace: this.ws, cwd: directory })).preview;
    await this.until(async () => !(await preview()).pending, 12);
    return (await preview()).options.claude;
  }
  metadataRequests() {
    const path = join(this.env.CLAUDE_CONFIG_DIR!, "metadata-requests.jsonl");
    return existsSync(path) ? lines(path).map(line => JSON.parse(line)) : [];
  }
  metadataCache() {
    const dir = join(this.env.XDG_STATE_HOME!, "corgi/account-previews");
    return join(
      dir,
      readdirSync(dir).find(name => name.startsWith("claude-cli-") && name.endsWith(".json"))!,
    );
  }
  expireMetadataUsage() {
    const path = this.metadataCache(),
      state = json(path);
    state.next_usage = 0;
    writeFileSync(path, JSON.stringify(state));
  }
  async test_claude_control_usage_reuses_process_and_cache_without_credentials() {
    // A stale credential file must not override Claude's own auth status.
    writeFileSync(
      join(this.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } }),
    );
    const first = await this.directoryPreview("first");
    this.assertEqual(first.account, "claude@example.com");
    this.assertTrue(first.signed_in);
    this.assertEqual(windows(first), claudeWindows);
    this.assertEqual(first.limits.windows[0].reset_at, 4070952000);
    for (let i = 0; i < 5; i++) await this.directoryPreview("shared" + i);
    this.assertEqual(this.metadataRequests().filter(r => r.kind === "get_usage").length, 1);
    this.assertEqual(this.metadataRequests().filter(r => r.kind === "auth").length, 1);
    this.expireMetadataUsage();
    await this.directoryPreview("refresh");
    const requests = this.metadataRequests().filter(r => r.kind === "get_usage");
    this.assertEqual(requests.length, 2);
    this.assertEqual(requests[0].pid, requests[1].pid);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.directoryPreview("after-reload");
    this.assertEqual(this.metadataRequests().filter(r => r.kind === "get_usage").length, 2);
    this.assertFalse(existsSync(this.launches));
  }
  async test_claude_usage_failure_keeps_account_and_stale_measurement() {
    const first = await this.directoryPreview("first");
    this.expireMetadataUsage();
    writeFileSync(join(this.env.CLAUDE_CONFIG_DIR!, "metadata.json"), JSON.stringify({ mode: "unsupported" }));
    const failed = await this.directoryPreview("unsupported");
    this.assertTrue(failed.signed_in);
    this.assertEqual(failed.account, first.account);
    this.assertEqual(windows(failed), claudeWindows);
    this.assertEqual(failed.usage_fetched_at, first.usage_fetched_at);
    this.assertEqual(failed.usage_error, "Claude usage request unsupported");
    await this.directoryPreview("cooldown");
    this.assertEqual(this.metadataRequests().filter(r => r.kind === "get_usage").length, 2);
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.until(async () => (await view.poll()).data.includes("Claude Code"));
    writeFileSync(join(this.env.CLAUDE_CONFIG_DIR!, "metadata.json"), "{}");
    this.expireMetadataUsage();
    const recovered = await this.directoryPreview("recovered");
    this.assertEqual(recovered.usage_error, "");
    this.assertEqual(this.metadataRequests().filter(r => r.kind === "start").length, 2);
  }
  async test_claude_account_switch_does_not_reuse_other_accounts_usage() {
    await this.directoryPreview("first");
    writeFileSync(
      join(this.env.CLAUDE_CONFIG_DIR!, "metadata.json"),
      JSON.stringify({ email: "other@example.com", mode: "malformed" }),
    );
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    const other = await this.directoryPreview("other");
    this.assertTrue(other.signed_in);
    this.assertEqual(other.account, "other@example.com");
    this.assertEqual(other.limits, { none: {} });
    this.assertEqual(other.usage_error, "Claude usage unavailable");
  }
  async test_claude_unknown_auth_remains_launchable() {
    writeFileSync(join(this.env.CLAUDE_CONFIG_DIR!, "metadata.json"), JSON.stringify({ authMalformed: true }));
    const unknown = await this.directoryPreview("unknown");
    this.assertIsNone(unknown.signed_in);
    this.assertEqual(unknown.usage_error, "Claude account unavailable");
    this.assertEqual(this.metadataRequests().filter(r => r.kind === "start").length, 0);
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02A");
    await this.clickText(view, "Claude Code");
    await this.until(() => existsSync(this.launches));
    await this.until(async () => (await view.poll()).data.includes("LAUNCH FIXTURE READY"));
  }
  async test_claude_usage_timeout_reaps_child_and_keeps_login() {
    writeFileSync(join(this.env.CLAUDE_CONFIG_DIR!, "metadata.json"), JSON.stringify({ mode: "hang" }));
    const info = await this.directoryPreview("hanging");
    this.assertTrue(info.signed_in);
    this.assertEqual(info.usage_error, "request timed out");
    const pid = this.metadataRequests().find(r => r.kind === "start").pid;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    this.assertFalse(alive);
    await this.directoryPreview("after-timeout");
    this.assertEqual(this.metadataRequests().filter(r => r.kind === "start").length, 1);
  }
  async test_corgi_intensity_migrates_and_previews_before_saving() {
    const file = join(this.env.XDG_STATE_HOME!, "corgi", "viewer.json");
    mkdirSync(join(this.env.XDG_STATE_HOME!, "corgi"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        onboarding_complete: true,
        sleeping_corgis: false,
        sidebar_width: 36,
        resources: { enabled: false },
      }),
    );
    const view = await Viewer.create(this, 100, 30);
    await view.input("\x02i");
    await this.clickText(view, "Visual flourishes", 100);
    await this.clickText(view, "Visual flourishes", 100);
    let rows = screen_text((await view.poll()).data, 100, 30);
    this.assertIn("Release notes", rows.join("\n"));
    this.assertNotIn("~ᐯ◡ᴥ◡ᐯ", rows.join("\n"));
    this.assertIn("ᶻ", rows.join("\n"));
    const sliderY = rows.findIndex(row => row.includes("0 Off")) - 1;
    this.assertGreaterEqual(sliderY, 0);
    const right = rows[sliderY].lastIndexOf("─");
    await view.input(`\x1b[<0;${right + 1};${sliderY + 1}M`);
    rows = screen_text((await view.poll()).data, 100, 30);
    this.assertIn("100%", rows.join("\n"));
    this.assertIn("~ᐯ◡ᴥ◡ᐯ", rows.join("\n"));
    this.assertEqual(json(file).sleeping_corgis, false);
    this.assertFalse("corgi_intensity" in json(file));
    await view.input(`\x1b[<0;${right + 1};${sliderY + 1}m`);
    this.assertEqual(json(file).corgi_intensity, 100);
    this.assertFalse("sleeping_corgis" in json(file));
    this.assertEqual(json(file).sidebar_width, 36);
    this.assertEqual(json(file).resources, { enabled: false });
    await view.input("\x1b[D");
    this.assertEqual(json(file).corgi_intensity, 95);
    await view.input("\x1b[H");
    this.assertEqual(json(file).corgi_intensity, 0);
    await view.close();
    const reopened = await Viewer.create(this, 100, 30);
    await reopened.input("\x02i");
    await this.clickText(reopened, "Visual flourishes", 100);
    rows = screen_text((await reopened.poll()).data, 100, 30);
    this.assertIn("Intensity", rows.join("\n"));
    this.assertNotIn("~ᐯ◡ᴥ◡ᐯ", rows.join("\n"));
    this.assertEqual(json(file).corgi_intensity, 0);
  }

  async test_corgi_setup_changes_inference_provider() {
    const view = await Viewer.create(this, 100, 30);
    const text = async () => screen_text((await view.poll()).data, 100, 30).join("\n");
    // A setting in the list, left of the options, which may repeat its name.
    const clickSetting = async (label: string) => {
      const rows = screen_text((await view.poll()).data, 100, 30);
      const y = rows.findIndex(row => row.indexOf(label) >= 0 && row.indexOf(label) < 30);
      this.assertGreaterEqual(y, 0, `missing ${label}`);
      return this.clickViewer(view, rows[y].indexOf(label) + 1, y + 1);
    };
    await view.input("\x02i");
    await this.until(async () => (await text()).includes("Corgi setup"));
    this.assertRegex(await text(), /Model +● Auto/);
    this.assertEqual((await this.session()).inference.choice, "auto");
    // Enter moves to the options, and again opens Model's on the one in use.
    await view.input("\r\r\x1b[B\x1b[B\r");
    await this.until(async () => (await this.session()).inference.choice === "claude");
    // Choosing a setting keeps setup open; only Esc closes it.
    await this.until(async () => /Model +● Claude/.test(await text()));
    this.assertIn("Corgi setup", await text());
    // Summaries turn off on their own switch, keeping the model.
    await this.clickText(view, "Activity summaries", 100);
    await this.until(async () => (await this.session()).inference.uses.activity === false);
    this.assertEqual((await this.session()).inference.choice, "claude");
    this.assertRegex(await text(), /Activity summaries +○ Off/);
    const readSaved = () => JSON.parse(readFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"), "utf8"));
    this.assertNotIn("When busy", await text());
    this.assertNotIn("Process card on hover", await text());
    this.assertNotIn("Amber alerts", await text());
    // The first click selects a setting; the next flips it.
    await clickSetting("Resources");
    await clickSetting("Resources");
    await this.until(async () => readSaved().resources.enabled === false);
    await this.until(async () => /Resources\s+Off/.test(await text()));
    // Mouse motion selects the setup row before a keyboard activation.
    await clickSetting("Clever Corgi");
    const setupRows = screen_text((await view.poll()).data, 100, 30);
    const resourceRow = setupRows.findIndex(row => row.includes("Resources"));
    this.assertGreaterEqual(resourceRow, 0);
    await view.input(`\x1b[<35;${setupRows[resourceRow].indexOf("Resources") + 1};${resourceRow + 1}M`);
    await view.input("\r");
    await this.until(async () => readSaved().resources.enabled === true);
    await this.until(async () => /Resources\s+On/.test(await text()));
    this.assertEqual(readSaved().corgi_intensity, 50);
    await clickSetting("Visual flourishes");
    await clickSetting("Visual flourishes");
    await view.input("\x1b[H");
    await this.until(async () => readSaved().corgi_intensity === 0);
    await view.input("\x1b");
    this.assertEqual(readSaved().resources, { enabled: true });
    await view.input("\x1b");
    await this.until(async () => !(await text()).includes("Corgi setup"));
    this.assertEqual((await this.session()).inference.choice, "claude");
    this.assertFalse((await this.session()).inference.uses.activity);
  }
  async test_launcher_resumes_a_closed_conversation_in_its_folder() {
    const view = await Viewer.create(this, 120, 30);
    // Written while Corgi runs: the daemon notices it without being asked.
    const session = "4f1c2b9e-0a6d-4c1e-9b7f-2d3e4f5a6b7c";
    const project = join(this.env.CLAUDE_CONFIG_DIR!, "projects", "fixture");
    mkdirSync(project, { recursive: true });
    const prompt = (content: string) =>
      JSON.stringify({
        type: "user",
        cwd: this.launchDir,
        gitBranch: "main",
        message: { role: "user", content },
      });
    writeFileSync(
      join(project, session + ".jsonl"),
      [
        prompt("fix the sidebar flicker"),
        JSON.stringify({ type: "ai-title", aiTitle: "Sidebar flicker fixture" }),
        prompt("does it work on linux?"),
      ].join("\n") + "\n",
    );
    // The newest closed conversations sit under the agents.
    await this.until(async () => {
      const rows = screen_text((await view.input("\x02A")).data, 120, 30);
      const shown = rows.some(row => row.includes("Sidebar flicker fixture") && row.includes("does it work on linux?"));
      if (!shown) await view.input("\x1b");
      return shown;
    }, 20);
    await view.input("/flicker");
    await this.until(async () => (await view.poll()).data.includes("1 in this workspace"));
    await view.input("\r");
    await this.until(() => existsSync(this.launches), 20);
    const launch = JSON.parse(lines(this.launches).at(-1)!);
    this.assertEqual(launch.args, ["--resume", session]);
    this.assertEqual(realpathSync(launch.cwd), this.launchDir);
    this.assertNotIn("New agent", (await view.poll()).data);
  }
  resume(session: string) {
    return this.command("agent.resume", {
      workspace: this.ws,
      cwd: this.launchDir,
      provider: "claude",
      session,
    }).then((created: any) => created.pane);
  }
  async test_a_failed_agent_keeps_its_tab_until_closed() {
    const failed = await this.resume("refused");
    await this.until(async () => {
      const { text } = await this.command("pane.read", {
        target: failed,
        view: "screen",
      });
      return text.includes("running in the background") && text.includes("# Exited with code 1");
    }, 20);
    // It no longer holds the conversation, so Resume starts it again.
    const kept = (await this.panes()).find((p: any) => p.id === failed);
    this.assertEqual(kept.session, "");
    // One that quits closes as before.
    const quits = await this.resume("quits");
    await this.until(async () => !(await this.panes()).some((p: any) => p.id === quits), 20);
    this.assertTrue((await this.panes()).some((p: any) => p.id === failed));
    await this.command("pane.close", { target: failed });
    this.assertFalse((await this.panes()).some((p: any) => p.id === failed));
  }
  async test_resume_attaches_to_a_session_claudes_daemon_runs() {
    // A live background process holds it, so `--resume` would refuse it.
    const held = "19e909c5-911c-4ab9-b49f-e5bbc7682b4a";
    const sessions = join(this.env.CLAUDE_CONFIG_DIR!, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: held,
        kind: "bg",
        jobId: "19e909c5",
      }),
    );
    const attached = await this.resume(held);
    const shown = (await this.panes()).find((p: any) => p.id === attached);
    this.assertEqual(shown.restoring, "claude attach 19e909c5");
    await this.until(() => existsSync(this.launches), 20);
    this.assertEqual(JSON.parse(lines(this.launches).at(-1)!).args, ["attach", "19e909c5"]);
  }
  async test_preview_project_model() {
    const project = join(this.temp.name, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({ model: "haiku" }));
    writeFileSync(join(project, ".claude/settings.local.json"), JSON.stringify({ model: "sonnet" }));
    const preview = async () =>
      (
        await this.rpc({
          op: "agent.preview",
          protocol: 1,
          workspace: this.ws,
          cwd: project,
        })
      ).preview;
    await this.until(async () => !(await preview()).pending, 12);
    const result = (await preview()).options.claude;
    this.assertEqual(result.model, "sonnet");
    this.assertEqual(result.model_name, "Sonnet");
    this.assertIn("Local settings", result.source);
  }
}

registerCase("agent launcher", Launcher, { timeout: 120_000 });
