/** Real viewer launch controls and read-only agent previews. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  registerCase,
  writeExecutable,
  shellJoin,
  quote,
  sleep,
  EXE,
  ROOT,
  JsonSocket,
} from "./support";
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
const claudeWindows = [[300, 12], [10080, 48]];
function hasLimits(row: string, short: number, weekly: number): boolean {
  return new RegExp(
    String.raw`\b5h(?:\s+━+)?\s+${short}%.*\b7d(?:\s+━+)?\s+${weekly}%`,
  ).test(row);
}

class Launcher extends Runtime {
  launches!: string;
  ws!: number;
  launchDir!: string;
  consentLog!: string;

  async configure() {
    const root = this.temp.name;
    writeExecutable(
      join(root, "curl"),
      `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.join(' ').includes('fixture-token')) throw new Error('token exposed in argv');
const input = await Bun.stdin.text();
if (!input.includes('Authorization: Bearer fixture-token')) throw new Error('missing private auth header');
process.stdout.write('HTTP/2 200\\r\\n\\r\\n');
console.log(JSON.stringify(args.at(-1).endsWith('/profile') ? {account:{email:'claude@example.com'}} : {five_hour:{utilization:12},seven_day:{utilization:48}}));
`,
    );
    this.env.PATH = `${root}:${this.env.PATH ?? ""}`;
    mkdirSync(this.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    writeFileSync(
      join(this.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fixture-token",
          subscriptionType: "max",
          expiresAt: Date.now() + 60000,
        },
      }),
    );
  }
  async setUp() {
    await super.setUp();
    writeFileSync(
      this.path + ".viewer.json",
      JSON.stringify({ onboarding_complete: true }),
    );
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
    const y = rows.findIndex((row) => row.includes(label));
    this.assertGreaterEqual(y, 0, `missing ${label}`);
    return this.clickViewer(view, rows[y].indexOf(label) + 1, y + 1);
  }
  async assertSelected(view: Viewer, label: string, cols = 120) {
    const rows = screen_text((await view.poll()).data, cols, 30);
    this.assertTrue(
      rows.some((row) =>
        new RegExp(
          "› +([0-9t→] +)?" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ).test(row),
      ),
      rows.join("\n"),
    );
  }
  async managerAction(view: Viewer, name: string, action: string) {
    const rows = screen_text((await view.poll()).data, 120, 30);
    const y = rows.findLastIndex(
      (row) => row.includes(name) && row.includes("[Edit]"),
    );
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
    await view.input("\x02a");
    await this.clickText(view, "Manage agents");
    await this.clickText(view, "Codex");
    this.assertEqual((await this.session()).agent_hidden, {
      codex: true,
      claude: false,
    });
    await this.clickText(view, "Paste a command");
    const source =
      "FOO=123 claude code --whatever 'two words' --prompt '" +
      "x".repeat(100) +
      "'\n";
    await view.input("\x1b[200~" + source + "\x1b[201~");
    this.assertIn("Claude Code", (await view.poll()).data);
    await view.input("\r");
    await this.waitSaved(0, source.trim());
    this.assertFalse(existsSync(this.launches));
    this.assertEqual(
      (await this.session()).agent_commands[0].command,
      source.trim(),
    );
    await this.managerAction(view, "Claude Code", "[✓]");
    this.assertTrue((await this.session()).agent_commands[0].hidden);
    await this.clickText(view, "[Done]");
    const rows = screen_text((await view.poll()).data, 120, 30);
    this.assertFalse(rows.some((row) => row.includes("Codex")));
    this.assertEqual(
      rows.filter((row) => row.includes("Claude Code")).length,
      1,
    );
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
    await view.input("\x02a");
    await this.clickText(view, "Manage agents");
    await view.input("FOO=123 claude --model sonnet");
    this.assertIn("FOO=123 claude --model sonnet", (await view.poll()).data);
    await this.clickText(view, "[Add]");
    await this.waitSaved(0, "FOO=123 claude --model sonnet");
    this.assertEqual(
      (await this.session()).agent_commands[0].command.length,
      "FOO=123 claude --model sonnet".length,
    );
    this.assertFalse(existsSync(this.launches));
    await this.managerAction(view, "Codex", "[Edit]");
    await view.input("codex --model example");
    await this.clickText(view, "[Save]");
    await this.waitSaved(1, "codex --model example");
    this.assertTrue((await this.session()).agent_hidden.codex);
    this.assertEqual(
      (await this.session()).agent_commands[1].command,
      "codex --model example",
    );
    this.assertIn("Paste a command", (await view.poll()).data);
    await view.input("abc");
    await view.input("\x1b[D");
    await view.input("X");
    this.assertIn("abXc", (await view.poll()).data);
    await view.input("\x1b");
    await this.until(async () =>
      (await view.poll()).data.includes("New agent"),
    );
  }
  async test_command_name_and_semantic_account_preview() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02a");
    await this.clickText(view, "Manage agents");
    const source =
      "ANTHROPIC_API_KEY=fixture-secret claude --model sonnet --dangerously-skip-permissions";
    await view.input(source);
    await this.until(async () =>
      (await view.poll()).data.includes("API key - identity unavailable"),
    );
    this.assertIn("Skips permission checks", (await view.poll()).data);
    this.assertIn("Claude Code - sonnet", (await view.poll()).data);
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
      return (await this.session()).agent_commands[0].name.startsWith(
        "Renamed assistant",
      );
    });
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    this.assertTrue(
      (await this.session()).agent_commands[0].name.startsWith(
        "Renamed assistant",
      ),
    );
  }
  async test_custom_agent_account_in_picker() {
    const config = join(this.temp.name, "work-profile");
    mkdirSync(config);
    writeFileSync(
      join(config, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }),
    );
    await this.command("agent.command", {
      index: 0,
      command: `CLAUDE_CONFIG_DIR=${quote(config)} claude --dangerously-skip-permissions`,
      name: "Work",
    });
    const view = await Viewer.create(this, 160, 30);
    await view.input("\x02a");
    const rows = screen_text((await view.poll()).data, 160, 30);
    const row = rows.find(
      (row) => row.includes("Work") && row.includes("work@example.com"),
    );
    this.assertIn("✓", row);
    this.assertIn("(cached)", row);
  }
  async test_signed_out_claude_is_hidden_but_manageable() {
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    unlinkSync(join(this.env.CLAUDE_CONFIG_DIR!, ".credentials.json"));
    for (const key of Object.keys(this.env))
      if (
        key.startsWith("CLAUDE_CODE_USE_") ||
        [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
        ].includes(key)
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
    await view.input("\x02a");
    await this.until(
      async () => !(await view.poll()).data.includes("Claude Code"),
    );
    await view.input("\x1b");
    await view.input("\x02a");
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
      writeFileSync(
        config,
        `function launchit\n ${quote(script)} --preset $argv\nend\nalias myagent launchit\n`,
      );
    } else {
      config = join(root, name === "bash" ? ".bashrc" : ".zshrc");
      writeFileSync(
        config,
        `launchit() { ${quote(script)} --preset "$@"; }\nalias myagent='launchit --fixed'\n`,
      );
    }
    await this.run_cli("start");
    const ws = (await this.session()).workspaces[0].id;
    const source = "FOO='123 with spaces' myagent --whatever 'two words'";
    await this.command("agent.command", { index: 0, command: source });
    this.assertFalse(existsSync(result));
    const saved = (await this.session()).agent_commands[0].command;
    this.assertNotIn("myagent", saved);
    this.assertNotIn("launchit", saved);
    writeFileSync(
      config,
      name === "fish"
        ? "function myagent\n echo WRONG\nend\n"
        : "alias myagent=false\n",
    );
    await this.command("agent.command.create", {
      workspace: ws,
      cwd: this.launchDir,
      index: 0,
    });
    await this.until(() => existsSync(result));
    this.assertEqual(json(result), {
      foo: "123 with spaces",
      args: [
        "--preset",
        ...(name === "fish" ? [] : ["--fixed"]),
        "--whatever",
        "two words",
      ],
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
    await view.input("\x02a");
    await this.clickText(view, "Manage agents");
    await view.input("cc\r");
    const expanded =
      "command claude --allow-dangerously-skip-permissions --dangerously-skip-permissions";
    await this.waitSaved(0, expanded);
    const entry = (await this.session()).agent_commands[0];
    this.assertEqual(entry.command, expanded);
    this.assertIn("Claude Code", (await view.poll()).data);
    writeFileSync(config, "function cc\n false\nend\n");
    await this.managerAction(view, "Claude Code", "[✓]");
    await this.managerAction(view, "Claude Code", "[ ]");
    this.assertEqual(
      (await this.session()).agent_commands[0].command,
      entry.command,
    );
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
    await view.input("\x02a");
    await this.clickText(view, "Manage agents");
    const baseline = existsSync(log) ? content(log) : "";
    // Continuous typing stays inside the debounce window.
    await view.input("cc");
    this.assertEqual(existsSync(log) ? content(log) : "", baseline);
    await this.until(async () =>
      (await view.poll()).data.includes("[Show command]"),
    );
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
    this.assertTrue(rows.some((row) => row.includes("│ cc ")));
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
    writeFileSync(
      config,
      prefix + "sleep .3\nalias cc 'claude --model stale'\n",
    );
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
    await this.until(
      async () => (await view.poll()).data.includes("fixture-codex"),
      12,
    );
    const text = screen_text((await view.poll()).data, 140, 30).join("\n");
    for (const value of [
      "Claude Code",
      "opus",
      "codex@example.com",
      "claude@example.com",
    ])
      this.assertIn(value, text);
    this.assertNotIn("User settings", text);
    const rows = screen_text((await view.poll()).data, 140, 30);
    this.assertTrue(
      rows.some(
        (row) =>
          row.includes("Codex") &&
          row.includes("fixture-codex") &&
          row.includes("codex@example.com"),
      ),
    );
    this.assertTrue(
      rows.some(
        (row) =>
          row.includes("Claude Code") &&
          row.includes("opus") &&
          row.includes("claude@example.com"),
      ),
    );
    this.assertTrue(
      rows.some(
        (row) =>
          row.includes("Codex") &&
          row.includes("pro") &&
          hasLimits(row, 23, 61),
      ),
    );
    this.assertTrue(
      rows.some(
        (row) =>
          row.includes("Claude Code") &&
          row.includes("max") &&
          hasLimits(row, 12, 48),
      ),
    );
    this.assertFalse(existsSync(this.launches));
    this.assertEqual((await this.session()).panes.length, 1);
    const y = rows.findIndex(
      (row) => row.includes("Claude Code") && row.includes("opus"),
    );
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
    const y = rows.findIndex((row) => row.includes("Codex"));
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
    this.assertIn(
      "--dangerously-bypass-approvals-and-sandbox",
      JSON.parse(lines(this.launches)[0]).args,
    );
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
    this.assertIn(
      "--dangerously-skip-permissions",
      JSON.parse(lines(this.launches)[1]).args,
    );
    await this.command("agent.yolo", { provider: "codex", enabled: false });
    await this.command("agent.create", {
      workspace: this.ws,
      provider: "codex",
    });
    await this.until(() => lines(this.launches).length === 3);
    this.assertNotIn(
      "--dangerously-bypass-approvals-and-sandbox",
      JSON.parse(lines(this.launches)[2]).args,
    );
  }
  async test_hover_and_dismiss_do_not_launch() {
    const view = await Viewer.create(this, 80, 24);
    this.assertIn("New agent", (await view.input("\x1b[<35;21;12M")).data);
    this.assertEqual((await this.session()).panes.length, 1);
    await view.input("\x1b[<35;75;2M");
    await this.until(
      async () => !(await view.poll()).data.includes("New agent"),
    );
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
    await view.input("\x02a");
    await this.until(
      async () => (await view.poll()).data.includes("claude@example.com"),
      12,
    );
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
    const shown = await view.input("\x02a");
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
    await this.until(async () =>
      (await view.poll()).data.includes("New agent"),
    );
    await view.input("\x1b[B");
    await this.assertSelected(view, "Claude Code", 100);
    await view.input("\x1b[B");
    await this.assertSelected(view, "New terminal", 100);
    await view.input("\x1b[B");
    await this.assertSelected(view, "Manage agents", 100);
    await view.input("\x1b[A");
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
    await this.assertSelected(view, "Manage agents", 100);
    await view.input("\t");
    await this.assertSelected(view, "Codex", 100);
    await view.input("\x1b");
    await this.until(
      async () => !(await view.poll()).data.includes("New agent"),
    );
    await sleep(0.6);
    this.assertNotIn("New agent", (await view.poll()).data);
    this.assertEqual(readFileSync(keys).length, 0);
    await view.input("\x1b[<35;98;2M");
    await view.input("\x1b[<35;21;15M");
    await this.until(async () =>
      (await view.poll()).data.includes("New agent"),
    );
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
      ["\x02a", "a"],
      ["\x02A", "A"],
      ["\x02\x01", "\x01"],
      ["\x1b[98;5u\x1b[97;5u", "\x1b[97;5u"],
    ]) {
      const before = (await this.session()).panes.length;
      this.assertIn("New agent", (await view.input(shortcut)).data);
      this.assertEqual((await this.session()).panes.length, before);
      await view.input("\x1b[H");
      await view.input("\x1b[B");
      this.assertRegex(
        (await view.poll()).data,
        / a \S* launch  \S* y \S* YOLO/,
      );
      await view.input(launch);
      await this.until(
        async () => (await this.session()).panes.length === before + 1,
      );
      this.assertEqual((await this.session()).last_agent, "claude");
    }
    await view.input("\x1b[<35;21;15M");
    this.assertIn("New agent", (await view.poll()).data);
    const before = (await this.session()).panes.length;
    await view.input("\x02A");
    this.assertEqual((await this.session()).panes.length, before);
    await view.input("A");
    await this.until(
      async () => (await this.session()).panes.length === before + 1,
    );
  }
  async test_numbered_agent_shortcuts_follow_visible_rows() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02a");
    let rows = screen_text((await view.poll()).data, 120, 30);
    this.assertTrue(rows.some((row) => /0 +Codex/.test(row)));
    this.assertTrue(rows.some((row) => /1 +Claude Code/.test(row)));
    this.assertTrue(rows.some((row) => /t +New terminal/.test(row)));
    let before = (await this.session()).panes.length;
    await view.input("1");
    await this.until(
      async () => (await this.session()).panes.length === before + 1,
    );
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
    await view.input("\x02a");
    rows = screen_text((await view.poll()).data, 120, 30);
    this.assertTrue(rows.some((row) => /0 +Claude Code/.test(row)));
    this.assertTrue(rows.some((row) => /1 +Custom sleeper/.test(row)));
    before = (await this.session()).panes.length;
    await view.input("9");
    this.assertEqual((await this.session()).panes.length, before);
    await view.input("1");
    await this.until(
      async () => (await this.session()).panes.length === before + 1,
    );
    this.assertNotIn("New agent", (await view.poll()).data);
  }
  async test_selection_survives_dismiss_and_other_viewer_launch() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02a");
    await view.input("\x1b[F");
    await view.input("\x1b");
    await view.input("\x02a");
    await this.assertSelected(view, "New terminal");
    await this.clickText(view, "Manage agents");
    await view.input("\x1b");
    await this.until(async () =>
      (await view.poll()).data.includes("New agent"),
    );
    await this.assertSelected(view, "New terminal");
    await view.input("\x1b");
    const other = await Viewer.create(this, 120, 30);
    await other.input("\x02a");
    await other.input("1");
    await this.until(
      async () => (await this.session()).last_agent === "claude",
    );
    await view.input("\x02a");
    await this.assertSelected(view, "New terminal");
    await view.input("\x1b");
    await view.input("\x1b[<35;118;2M");
    await view.input("\x1b[<35;21;15M");
    const rows = screen_text((await view.poll()).data, 120, 30);
    const y = rows.findIndex((row) => row.includes("Codex"));
    await view.input(`\x1b[<35;${rows[y].indexOf("Codex") + 1};${y + 1}M`);
    await view.input("\x1b[<35;118;2M");
    this.assertNotIn("New agent", (await view.poll()).data);
    await view.input("\x02a");
    await this.assertSelected(view, "Codex");
  }
  async test_each_workspace_keeps_its_agent_and_new_ones_start_on_the_last() {
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02a");
    await view.input("1");
    await this.until(
      async () => (await this.session()).workspaces[0].last_agent === "claude",
    );
    const other = (
      await this.command("workspace.create", {
        name: "Other",
        cwd: this.launchDir,
      })
    ).workspace;
    await view.poll();
    await view.request({ op: "workspace", workspace: other });
    await view.input("\x02a");
    await this.assertSelected(view, "Claude Code");
    await view.input("0");
    const workspace = async (id: number) =>
      (await this.session()).workspaces.find((ws: any) => ws.id === id);
    await this.until(
      async () => (await workspace(other)).last_agent === "codex",
    );
    this.assertEqual((await this.session()).last_agent, "codex");
    await view.request({ op: "workspace", workspace: this.ws });
    await view.input("\x02a");
    await this.assertSelected(view, "Claude Code");
    await view.input("\x1b");
    await this.until(
      async () => !(await view.poll()).data.includes("New agent"),
    );
    await this.command("agent.create", { workspace: this.ws });
    this.assertEqual((await this.session()).last_agent, "claude");
    this.assertEqual((await workspace(other)).last_agent, "codex");
    await view.request({ op: "workspace", workspace: other });
    await view.input("\x02a");
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
    await view.input("\x02a");
    await view.input("2");
    this.assertEqual((await this.session()).panes.length, 2);
    await view.input("\x02a");
    await this.assertSelected(view, "Custom sleeper");
    await this.clickViewer(view, 118, 2);
    await view.input("\x02a");
    await this.assertSelected(view, "Custom sleeper");
    await view.input("\x1b");
    await this.command("agent.command", {
      index: 0,
      command: "sleep 120",
      name: "Custom sleeper",
      hidden: true,
      resolve: false,
    });
    await view.input("\x02a");
    await this.assertSelected(view, "Codex");
    this.assertNotIn("Custom sleeper", (await view.poll()).data);
  }
  async test_new_terminal_row_opens_a_plain_tab() {
    const view = await Viewer.create(this, 100, 30);
    this.assertIn("New terminal", (await view.input("\x02a")).data);
    const before = (await this.session()).panes.length;
    await view.input("t");
    await this.until(
      async () => (await this.session()).panes.length === before + 1,
    );
    this.assertNotIn("New agent", (await view.poll()).data);
    await view.input("\x02a");
    await this.assertSelected(view, "New terminal", 100);
    this.assertRegex((await view.poll()).data, / a \S* open/);
    await view.input("\r");
    await this.until(
      async () => (await this.session()).panes.length === before + 2,
    );
    await view.input("\x02a");
    await view.input("\x02a");
    this.assertEqual((await this.session()).panes.length, before + 2);
    this.assertIn("New agent", (await view.poll()).data);
    await view.input("t");
    await this.until(
      async () => (await this.session()).panes.length === before + 3,
    );
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
      await this.until(
        async () => (await this.session()).panes.length === before + 1,
      );
      this.assertNotIn("New agent", (await view.poll()).data);
    }
  }
  async test_claude_subscription_usage_and_private_auth_header() {
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    const root = this.temp.name;
    writeExecutable(
      join(root, "curl"),
      `const args = process.argv.slice(2);
if (args.join(' ').includes('fixture-token')) throw new Error('token exposed');
if (!['https://api.anthropic.com/api/oauth/usage','https://api.anthropic.com/api/oauth/profile'].includes(args.at(-1))) throw new Error('wrong endpoint');
if (!(await Bun.stdin.text()).includes('Authorization: Bearer fixture-token')) throw new Error('missing authorization');
process.stdout.write('HTTP/2 200\\r\\n\\r\\n');
console.log(JSON.stringify(args.at(-1).endsWith('/profile') ? {account:{email:'claude@example.com'}} : {five_hour:{utilization:12,resets_at:'2099-01-01T12:00:00.000000+00:00'},seven_day:{utilization:48,resets_at:'2099-01-04T12:00:00Z'}}));
`,
    );
    this.env.PATH = `${root}:${this.env.PATH ?? ""}`;
    writeFileSync(
      join(this.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fixture-token",
          subscriptionType: "max",
          expiresAt: Date.now() + 60000,
        },
      }),
    );
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
    const option = (await preview()).options.claude;
    this.assertEqual(option.plan, "max");
    this.assertEqual(windows(option), claudeWindows);
    this.assertNotIn("fixture-token", JSON.stringify(await preview()));
    this.assertTrue(option.limits.windows.every((w: any) => w.reset_at !== null));
    const view = await Viewer.create(this, 160, 30);
    await view.input("\x02a");
    const row = await this.until(
      async () =>
        screen_text((await view.poll()).data, 160, 30).find(
          (row) => row.includes("Claude Code") && hasLimits(row, 12, 48),
        ),
      12,
    );
    this.assertRegex(row!, /\b5h.*12% · \d+d(?: \d+h)?\s*│\s*7d.*48% · \d+d(?: \d+h)?/);
  }
  accountCacheFixture() {
    const root = this.temp.name,
      log = join(root, "account-requests.jsonl"),
      mode = join(root, "usage-mode");
    writeFileSync(mode, "ok");
    writeExecutable(
      join(root, "curl"),
      `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2); await Bun.stdin.text();
if (args.join(' ').includes('fixture-token')) throw new Error('token exposed');
const endpoint = args.at(-1).split('/').at(-1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(endpoint) + '\\n');
const limited = endpoint === 'usage' && readFileSync(${JSON.stringify(mode)}, 'utf8') === 'limited';
process.stdout.write(limited ? 'HTTP/2 429\\r\\nRetry-After: 120\\r\\n\\r\\n' : 'HTTP/2 200\\r\\n\\r\\n');
console.log(JSON.stringify(limited ? {error:{type:'rate_limit_error'}} : endpoint === 'profile' ? {account:{email:'claude@example.com'}} : {five_hour:{utilization:12},seven_day:{utilization:48}}));
`,
    );
    return [log, mode] as const;
  }
  async directoryPreview(name: string) {
    const directory = join(this.temp.name, name);
    mkdirSync(directory, { recursive: true });
    const preview = async () =>
      (
        await this.rpc({
          op: "agent.preview",
          protocol: 1,
          workspace: this.ws,
          cwd: directory,
        })
      ).preview;
    await this.until(async () => !(await preview()).pending, 12);
    return (await preview()).options.claude;
  }
  async test_account_requests_shared_across_directories_reload_and_credentials() {
    const [log] = this.accountCacheFixture();
    for (let i = 0; i < 10; i++) await this.directoryPreview("dir" + i);
    this.assertEqual(lines(log).filter((line) => line === '"usage"').length, 1);
    this.assertEqual(
      lines(log).filter((line) => line === '"profile"').length,
      1,
    );
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    await this.directoryPreview("after-reload");
    this.assertEqual(lines(log).filter((line) => line === '"usage"').length, 1);
    const credentials = join(this.env.CLAUDE_CONFIG_DIR!, ".credentials.json");
    const data = json(credentials);
    data.claudeAiOauth.accessToken = "fixture-token-other";
    writeFileSync(credentials, JSON.stringify(data));
    await this.directoryPreview("other-account");
    this.assertEqual(lines(log).filter((line) => line === '"usage"').length, 2);
    const cache = join(this.env.XDG_STATE_HOME!, "corgi/account-previews");
    this.assertNotIn(
      "fixture-token",
      readdirSync(cache)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name + content(join(cache, name)))
        .join(""),
    );
  }
  async test_rate_limit_keeps_identity_and_cached_usage_and_honors_cooldown() {
    const [log, mode] = this.accountCacheFixture();
    const initial = await this.directoryPreview("initial");
    const fetchedAt = initial.usage_fetched_at;
    this.assertGreaterEqual(fetchedAt, Math.floor(Date.now() / 1000) - 10);
    const cacheDir = join(this.env.XDG_STATE_HOME!, "corgi/account-previews");
    const cache = join(
      cacheDir,
      readdirSync(cacheDir).find(
        (name) => name.startsWith("claude-") && name.endsWith(".json"),
      )!,
    );
    const state = json(cache);
    state.next_usage = 0;
    state.next_profile = 0;
    writeFileSync(cache, JSON.stringify(state));
    writeFileSync(mode, "limited");
    const option = await this.directoryPreview("limited");
    this.assertEqual(option.account, "claude@example.com");
    this.assertEqual(windows(option), claudeWindows);
    this.assertEqual(option.usage_fetched_at, fetchedAt);
    this.assertEqual(option.usage_error, "server returned 429");
    this.assertEqual(json(cache).info.usage_fetched_at, fetchedAt);
    this.assertGreaterEqual(json(cache).next_usage, Date.now() / 1000 + 115);
    await this.rpc({ op: "server.reload", protocol: 1, executable: EXE });
    const reloaded = await this.directoryPreview("still-limited");
    this.assertEqual(windows(reloaded), claudeWindows);
    this.assertEqual(reloaded.usage_fetched_at, fetchedAt);
    this.assertEqual(lines(log).filter((line) => line === '"usage"').length, 2);

    const aged = json(cache);
    aged.info.usage_fetched_at = Math.floor(Date.now() / 1000) - 601;
    writeFileSync(cache, JSON.stringify(aged));
    // Viewers hide an expired reading; the preview keeps it with its age.
    const stale = await this.directoryPreview("stale");
    this.assertEqual(windows(stale), claudeWindows);
    this.assertEqual(stale.usage_fetched_at, aged.info.usage_fetched_at);
    this.assertEqual(stale.usage_error, "server returned 429");
    this.assertEqual(windows(json(cache).info), claudeWindows);
    this.assertEqual(lines(log).filter((line) => line === '"usage"').length, 2);

    aged.next_usage = 0;
    writeFileSync(cache, JSON.stringify(aged));
    const failed = await this.directoryPreview("stale-failed-refresh");
    this.assertEqual(windows(failed), claudeWindows);
    this.assertEqual(failed.usage_fetched_at, aged.info.usage_fetched_at);
    this.assertEqual(json(cache).info.usage_fetched_at, aged.info.usage_fetched_at);

    const retry = json(cache);
    retry.next_usage = 0;
    writeFileSync(cache, JSON.stringify(retry));
    writeFileSync(mode, "ok");
    const refreshed = await this.directoryPreview("refreshed");
    this.assertEqual(windows(refreshed), claudeWindows);
    this.assertGreaterEqual(refreshed.usage_fetched_at, fetchedAt);
    this.assertEqual(json(cache).info.usage_fetched_at, refreshed.usage_fetched_at);
    this.assertEqual(refreshed.usage_error, "");

    const credentials = join(this.env.CLAUDE_CONFIG_DIR!, ".credentials.json");
    const expired = json(credentials);
    expired.claudeAiOauth.expiresAt = Date.now() - 1;
    writeFileSync(credentials, JSON.stringify(expired));
    const requests = lines(log).length;
    const expiredToken = await this.directoryPreview("expired-token");
    this.assertEqual(windows(expiredToken), claudeWindows);
    this.assertEqual(expiredToken.usage_fetched_at, refreshed.usage_fetched_at);
    this.assertEqual(expiredToken.usage_error, "access token expired");
    this.assertEqual(lines(log).length, requests);
  }
  async test_first_usage_429_still_fetches_profile() {
    const [log, mode] = this.accountCacheFixture();
    writeFileSync(mode, "limited");
    const option = await this.directoryPreview("limited-first");
    this.assertEqual(option.account, "claude@example.com");
    this.assertEqual(option.limits, { rate_limited: {} });
    this.assertEqual(option.usage_error, "server returned 429");
    await this.directoryPreview("another-directory");
    this.assertEqual(lines(log).filter((line) => line === '"usage"').length, 1);
    const view = await Viewer.create(this, 120, 30);
    await view.input("\x02a");
    await this.until(async () => screen_text((await view.poll()).data, 120, 30).some(
      (row) => row.includes("Claude Code") && row.includes("Unavailable · server returned 429"),
    ));
  }
  async consentFixture(allowed = false, deny = false) {
    await this.run_cli("shutdown");
    await this.until(() => !existsSync(this.path));
    const root = this.temp.name;
    const credentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: "fixture-token",
        subscriptionType: "max",
        expiresAt: Date.now() + 60000,
      },
    });
    const fixture = join(root, "credentials-fixture.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        silent: allowed ? { credentials } : { needs_consent: true },
        interactive: deny
          ? { needs_consent: true, delay_ms: 250 }
          : { credentials, delay_ms: 250 },
      }),
    );
    this.consentLog = join(root, "credential-access.log");
    this.env.CORGI_TEST_CLAUDE_CREDENTIALS = fixture;
    this.env.CORGI_TEST_CLAUDE_CREDENTIAL_LOG = this.consentLog;
    writeExecutable(
      join(root, "curl"),
      `const args = process.argv.slice(2);
if (args.join(' ').includes('fixture-token')) throw new Error('token exposed');
if (!(await Bun.stdin.text()).includes('Authorization: Bearer fixture-token')) throw new Error('missing authorization');
process.stdout.write('HTTP/2 200\\r\\n\\r\\n');
console.log(JSON.stringify(args.at(-1).endsWith('/profile') ? {account:{email:'claude@example.com'}} : {five_hour:{utilization:12},seven_day:{utilization:48}}));
`,
    );
    this.env.PATH = `${root}:${this.env.PATH ?? ""}`;
    await this.run_cli("start");
    this.ws = (await this.session()).workspaces[0].id;
    await this.command("pane.create", {
      workspace: this.ws,
      cwd: this.launchDir,
      command: "sleep 120",
    });
    return Viewer.create(this, 100, 30);
  }
  async usageRows(view: Viewer) {
    return screen_text((await view.poll()).data, 100, 30);
  }
  async test_track_usage_is_explicit_and_does_not_launch_an_agent() {
    const view = await this.consentFixture();
    await this.until(() => existsSync(this.consentLog));
    this.assertEqual(lines(this.consentLog), ["silent"]);
    await this.clickViewer(view, 26, 15);
    await this.until(async () =>
      (await this.usageRows(view)).some(
        (row) => row.includes("Claude Code") && row.includes("Track usage"),
      ),
    );
    this.assertEqual(lines(this.consentLog), ["silent"]);
    await view.input("\x1b");
    await this.clickViewer(view, 26, 15);
    const rows = await this.usageRows(view),
      y = rows.findIndex((row) => row.includes("Claude Code"));
    const x = rows[y].indexOf("Track usage"),
      count = (await this.session()).panes.length;
    await this.clickViewer(view, x + 1, y + 1);
    await this.clickViewer(view, x + 1, y + 1);
    await this.until(async () =>
      (await this.usageRows(view)).some(
        (row) => row.includes("Claude Code") && hasLimits(row, 12, 48),
      ),
    );
    this.assertEqual(lines(this.consentLog), ["silent", "interactive"]);
    this.assertEqual((await this.session()).panes.length, count);
    this.assertFalse(existsSync(this.launches));
    this.assertIn("New agent", (await view.poll()).data);
  }
  async test_denied_tracking_is_not_retried_interactively() {
    const view = await this.consentFixture(false, true);
    await this.clickViewer(view, 26, 15);
    await this.until(async () =>
      (await view.poll()).data.includes("Track usage"),
    );
    await view.input("\x1b[B");
    await view.input("u");
    await this.until(
      () =>
        lines(this.consentLog).filter((line) => line === "interactive")
          .length === 1,
    );
    await this.until(async () =>
      (await view.poll()).data.includes("Track usage"),
    );
    const another = join(this.temp.name, "another");
    mkdirSync(another);
    const preview = async () =>
      (
        await this.rpc({
          op: "agent.preview",
          protocol: 1,
          workspace: this.ws,
          cwd: another,
        })
      ).preview;
    await this.until(async () => !(await preview()).pending);
    this.assertEqual(lines(this.consentLog), [
      "silent",
      "interactive",
      "silent",
    ]);
    this.assertTrue((await preview()).options.claude.usage_needs_consent);
    this.assertFalse(existsSync(this.launches));
  }
  async test_already_authorized_usage_loads_silently() {
    const view = await this.consentFixture(true);
    await this.clickViewer(view, 26, 15);
    await this.until(async () =>
      (await this.usageRows(view)).some((row) => hasLimits(row, 12, 48)),
    );
    this.assertNotIn("Track usage", (await view.poll()).data);
    this.assertEqual(lines(this.consentLog), ["silent"]);
  }
  async test_corgi_setup_changes_inference_provider() {
    const view = await Viewer.create(this, 100, 30);
    const text = async () =>
      screen_text((await view.poll()).data, 100, 30).join("\n");
    await view.input("\x02i");
    await this.until(async () => (await text()).includes("Corgi setup"));
    this.assertIn("Who writes activity summaries", await text());
    this.assertIn("● Auto", await text());
    this.assertEqual((await this.session()).inference.choice, "auto");
    await view.input("\x1b[B\x1b[B\r");
    await this.until(
      async () => (await this.session()).inference.choice === "claude",
    );
    // Choosing a setting keeps setup open; only Esc closes it.
    await this.until(async () => (await text()).includes("● Claude"));
    this.assertIn("Corgi setup", await text());
    await this.clickText(view, "no summaries, plain links", 100);
    await this.until(
      async () => (await this.session()).inference.choice === "off",
    );
    this.assertIsNone((await this.session()).inference.provider);
    const readSaved = () =>
      JSON.parse(
        readFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"), "utf8"),
      );
    this.assertNotIn("When busy", await text());
    this.assertNotIn("Process card on hover", await text());
    this.assertNotIn("Amber alerts", await text());
    await this.clickText(view, "Resource readings", 100);
    await this.until(async () => readSaved().resources.enabled === false);
    await this.until(async () => /Resource readings\s+○ Off/.test(await text()));
    // Mouse motion selects the setup row before a keyboard activation.
    const setupRows = screen_text((await view.poll()).data, 100, 40);
    const resourceRow = setupRows.findIndex(row => row.includes("Resource readings"));
    this.assertGreaterEqual(resourceRow, 0);
    await view.input(`\x1b[<35;${setupRows[resourceRow].indexOf("Resource readings") + 1};${resourceRow + 1}M`);
    await view.input("\r");
    await this.until(async () => readSaved().resources.enabled === true);
    await this.until(async () => /Resource readings\s+● On/.test(await text()));
    this.assertEqual(readSaved().sleeping_corgis, true);
    await this.clickText(view, "Sleeping corgis", 100);
    await this.until(async () => readSaved().sleeping_corgis === false);
    this.assertEqual(readSaved().resources, { enabled: true });
    await view.input("\x1b");
    await this.until(async () => !(await text()).includes("Corgi setup"));
    this.assertEqual((await this.session()).inference.choice, "off");
  }
  async test_preview_project_model() {
    const project = join(this.temp.name, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(
      join(project, ".claude/settings.json"),
      JSON.stringify({ model: "haiku" }),
    );
    writeFileSync(
      join(project, ".claude/settings.local.json"),
      JSON.stringify({ model: "sonnet" }),
    );
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
    this.assertIn("Local settings", result.source);
  }
}

registerCase("agent launcher", Launcher, { timeout: 120_000 });
