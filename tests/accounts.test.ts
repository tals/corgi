/** Agents in a provider account besides the default: hooks, launches, the
 * guided sign-in and `corgi account`. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXE, ROOT, registerCase, quote, writeExecutable, deadline } from "./support";
import { Runtime, screen_text } from "./runtime";
import { Viewer } from "./viewer_client";
import { write_ordinary_agent } from "./provider_sim";

const signin_url = "https://claude.com/cai/oauth/authorize?code=true&state=" + "abcdef".repeat(30);

/** Whether Corgi's handler is in the Claude settings at `settings`. */
const hooked = (settings: string) =>
  existsSync(settings) &&
  JSON.parse(readFileSync(settings, "utf8")).hooks?.SessionStart?.some((group: any) =>
    group.hooks?.some((h: any) => h.command?.includes("hook claude")),
  ) === true;
const signIn = (dir: string, email: string, id = email) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: id, organizationUuid: "org" } }),
  );
};

class Accounts extends Runtime {
  /** An account Omarchy keeps, which Corgi finds in its list. */
  work!: string;
  /** A Claude whose first run signs in: it asks how, shows a link, and takes
   * the code pasted back as the login; then it is the ordinary agent. */
  first_run!: string;
  async configure() {
    const root = this.temp.name,
      agent = write_ordinary_agent(join(root, "bin", "claude"));
    this.env.CORGI_CLAUDE_BIN = agent;
    const omarchy = join(this.env.XDG_STATE_HOME!, "omarchy", "agents", "accounts");
    this.work = join(omarchy, "claude", "work");
    signIn(this.work, "me@work.com");
    this.work = realpathSync(this.work);
    writeFileSync(
      join(omarchy, "claude.json"),
      JSON.stringify({
        active: "main",
        accounts: [
          { id: "main", label: "Main", home: "", primary: true },
          { id: "work", label: "Work", home: this.work, primary: false },
        ],
      }),
    );
    signIn(join(root, ".claude-typed"), "me@typed.com");
    this.first_run = writeExecutable(
      join(root, "signin", "claude"),
      `#!/bin/sh
dir="$CLAUDE_CONFIG_DIR"
case "$1 $2" in
"auth status") grep -q oauthAccount "$dir/.claude.json" 2>/dev/null; exit $? ;;
"auth logout") echo "$dir" >> "$HOME/logouts"; rm -f "$dir/.claude.json"; exit 0 ;;
esac
if ! grep -q hasCompletedOnboarding "$dir/.claude.json" 2>/dev/null; then
  printf 'Select login method:\\n> 1. Claude account with subscription\\n'
  read -r _ || exit 1
  printf '${signin_url}\\nPaste code here if prompted > '
  read -r code || exit 1
  [ -n "$code" ] || exit 1
  printf '{"oauthAccount":{"emailAddress":"%s@example.com","accountUuid":"%s","organizationUuid":"org"},"hasCompletedOnboarding":true}' "$code" "$code" > "$dir/.claude.json"
  sleep 30
fi
exec ${quote(agent)} "$@"`,
    );
  }
  async workspace() {
    return (await this.session()).workspaces[0].id as number;
  }
  async screen(pane: number) {
    return (await this.command("pane.read", { target: pane, view: "screen" })).text as string;
  }
  async shows(pane: number, text: string) {
    return this.until(async () => (await this.screen(pane)).includes(text), 15000);
  }
  /** A tab running the guided `corgi account add claude [NAME]`; its
   * folder is the first free number. */
  async adding(name = "") {
    // Wide enough for the frame's longest line.
    if (!this.client) [this.client] = await this.viewer(160, 40);
    const command = `CORGI_CLAUDE_BIN=${quote(this.first_run)} ${quote(EXE)} account add claude ${name}`,
      { pane } = await this.open_pane({ cwd: this.temp.name, command });
    await this.shows(pane, "Select login method");
    return { pane, dir: join(realpathSync(join(this.env.XDG_STATE_HOME!, "corgi", "accounts", "claude")), "1") };
  }
  listed() {
    const path = join(this.env.XDG_STATE_HOME!, "corgi", "accounts.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).accounts : [];
  }
  logouts() {
    const path = join(this.temp.name, "logouts");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
  }

  async test_an_omarchy_account_gets_hooks_and_starts_agents_in_its_folder() {
    this.assertTrue(hooked(join(this.work, "settings.json")), "startup adds hooks to every account");
    const listed = (await this.session()).accounts;
    this.assertEqual(listed, [{ provider: "claude", account: this.work, name: "Work", managed: false }]);
    const { pane } = await this.command("agent.create", {
      workspace: await this.workspace(),
      cwd: this.temp.name,
      provider: "claude",
      account: this.work,
    });
    const shown = await this.until(async () =>
      (await this.panes()).find((p: any) => p.id === pane && p.session === "ordinary-claude"),
    );
    this.assertEqual(shown.account, this.work);
  }

  async test_a_saved_command_runs_in_the_account_its_shell_expands() {
    const command = `PATH=${quote(join(this.temp.name, "bin"))}:$PATH CLAUDE_CONFIG_DIR=$HOME/.claude-typed claude`;
    await this.command("agent.command", { index: 0, command, resolve: false });
    const { pane } = await this.command("agent.command.create", {
      workspace: await this.workspace(),
      cwd: this.temp.name,
      index: 0,
    });
    // Its folder has no hooks yet, so the agent shows before it reports.
    const typed = realpathSync(join(this.temp.name, ".claude-typed")),
      shown = await this.until(async () =>
        (await this.panes()).find((p: any) => p.id === pane && p.provider === "claude" && p.account),
      );
    this.assertEqual(shown.account, typed);
  }

  async test_an_agent_typed_under_another_folder_is_remembered_and_reports_from_its_next_start() {
    const side = join(this.temp.name, "side-claude");
    signIn(side, "me@side.com");
    const pane = (await this.open_pane({ cwd: this.temp.name })).pane,
      start = `PATH=${quote(join(this.temp.name, "bin"))}:$PATH CLAUDE_CONFIG_DIR=${quote(side)} claude\r`;
    await this.command("pane.input", { target: pane, data: start });
    const first = await this.until(async () =>
      (await this.panes()).find((p: any) => p.id === pane && p.provider === "claude"),
    );
    this.assertEqual(first.account, realpathSync(side));
    // Discovery can install hooks before the first process reads them.
    await this.until(() => hooked(join(side, "settings.json")));
    this.assertEqual(this.listed(), [
      { provider: "claude", dir: realpathSync(side), name: "side-claude", managed: false },
    ]);
    const next = (await this.open_pane({ cwd: this.temp.name })).pane;
    await this.command("pane.input", { target: next, data: start });
    await this.until(async () =>
      (await this.panes()).find((p: any) => p.id === next && p.session === "ordinary-claude"),
    );
  }

  async test_the_account_command_adds_lists_and_forgets_a_folder() {
    const client = join(this.temp.name, "client");
    signIn(client, "me@client.com");
    const added = await this.run_cli("account", "add", "claude", "client", "--dir", client);
    this.assertTrue(added.includes("signed in as me@client.com"), added);
    this.assertTrue(hooked(join(client, "settings.json")), "adding an account adds its hooks");
    const list = await this.run_cli("account", "list");
    this.assertTrue(/Claude Code\s+client\s+me@client\.com\s+~\/client/.test(list), list);
    this.assertTrue(/Claude Code\s+Work\s+me@work\.com/.test(list), list);
    this.assertTrue((await this.run_cli("account", "rename", "Work", "office")).includes("Renamed Work to office"));
    this.assertTrue(/Claude Code\s+office\s+me@work\.com/.test(await this.run_cli("account", "list")));
    // The default takes a name of its own, which `default` still finds.
    await this.run_cli("account", "rename", "claude/default", "home");
    this.assertTrue(/Claude Code\s+home\s.*\(default\)/.test(await this.run_cli("account", "list")));
    await this.run_cli("account", "rename", "home", "");
    this.assertTrue(/Claude Code\s+default\s/.test(await this.run_cli("account", "list")));
    const removed = await this.run_cli("account", "remove", "office");
    this.assertTrue(removed.includes("Forgot office; its folder stays"), removed);
    const after = await this.run_cli("account", "list");
    this.assertTrue(!after.includes("me@work.com"), after);
    this.assertTrue(existsSync(this.work), "forgetting an account keeps its folder");
  }

  async test_a_new_account_signs_in_through_its_agent_and_moves_in_once_it_did() {
    const home = this.env.CLAUDE_CONFIG_DIR!;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "CLAUDE.md"), "be brief");
    writeFileSync(join(home, "settings.json"), "{}");
    const { pane, dir } = await this.adding();
    this.assertTrue(lstatSync(dir).isSymbolicLink(), "until it signs in, the account is a link to a staging folder");
    this.assertTrue((await this.screen(pane)).includes("Add account · Claude Code"));
    this.assertEqual(this.listed(), []);
    await this.command("pane.input", { target: pane, data: "\r" });
    await this.shows(pane, "paste it here");
    await this.command("pane.input", { target: pane, data: "side\r" });
    // Named for the login's company, then launched without another keypress.
    const shown = await this.until(async () =>
      (await this.panes()).find((p: any) => p.id === pane && p.session === "ordinary-claude"),
    );
    this.assertEqual(shown.account, dir);
    this.assertTrue(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), "its folder moved in");
    this.assertEqual(readlinkSync(join(dir, "CLAUDE.md")), join(home, "CLAUDE.md"));
    this.assertEqual(readlinkSync(join(dir, "settings.json")), join(home, "settings.json"));
    this.assertTrue(hooked(join(home, "settings.json")), "its shared settings have the hooks");
    const folder = lstatSync(dir, { bigint: true });
    this.assertEqual(this.listed(), [
      {
        provider: "claude",
        dir,
        name: "example",
        managed: true,
        created: `${folder.dev}:${folder.ino}:${folder.birthtimeNs}`,
      },
    ]);
  }

  async test_adding_an_account_in_the_viewer_opens_its_agent_and_confirms_it() {
    this.env.CORGI_CLAUDE_BIN = this.first_run;
    writeFileSync(this.path + ".viewer.json", JSON.stringify({ onboarding_complete: true }));
    const view = await Viewer.create(this, 160, 40);
    await view.input("\x02A");
    await view.input("\x1b[C");
    await view.advance(0.3);
    await view.input("/add claude\t\r");
    await this.until(async () => (await view.poll()).data.includes("Select login method"));
    await view.input("\r");
    await this.until(async () => (await view.poll()).data.includes("paste it here"));
    await view.input("side\r");
    const dir = join(realpathSync(join(this.env.XDG_STATE_HOME!, "corgi", "accounts", "claude")), "1"),
      pane = await this.until(async () =>
        (await this.panes()).find((p: any) => p.session === "ordinary-claude" && p.account === dir),
      );
    const rows = await this.until(async () => {
      const rows = screen_text((await view.poll()).data, 160, 40);
      return rows.some(row => row.includes("✓ Added Claude Code · example")) ? rows : null;
    });
    this.assertFalse(rows.some(row => row.includes("Manage agents") || row.includes("Add account ·")));
    // Input goes straight to the newly focused agent, without confirming anything.
    await view.input("work\r");
    await this.shows(pane.id, "Working");
    this.assertEqual(
      this.listed().map((a: any) => a.name),
      ["example"],
    );
    await view.advance(3.1);
    const after = screen_text((await view.poll()).data, 160, 40);
    this.assertFalse(
      after.some(row => row.includes("✓ Added")),
      "the confirmation dismisses itself",
    );
  }

  async test_cancelling_a_new_account_deletes_it_and_signs_it_out() {
    const before = await this.adding("gone");
    await this.command("pane.input", { target: before.pane, data: "\x03" });
    await this.until(() => !existsSync(before.dir) && !this.lstat(before.dir));
    this.assertEqual(this.logouts(), [], "no one had signed in to sign out");
    // A login another account has already: deleting it signs it out first.
    signIn(this.env.CLAUDE_CONFIG_DIR!, "twice@example.com", "twice");
    const twice = await this.adding("twice");
    const temp = readlinkSync(twice.dir);
    await this.command("pane.input", { target: twice.pane, data: "\r" });
    await this.shows(twice.pane, "paste it here");
    await this.command("pane.input", { target: twice.pane, data: "twice\r" });
    await this.shows(twice.pane, "twice@example.com is signed in to Claude Code · default already.");
    await this.command("pane.input", { target: twice.pane, data: "\x03" });
    await this.until(() => !this.lstat(twice.dir) && !existsSync(temp));
    this.assertEqual(this.logouts(), [twice.dir]);
    this.assertEqual(this.listed(), []);
    this.assertTrue(existsSync(join(this.env.CLAUDE_CONFIG_DIR!, ".claude.json")), "the default keeps its login");
  }
  async test_signin_link_hover_copies_the_wrapped_url_and_closes_with_signin() {
    this.env.CORGI_CLAUDE_BIN = this.first_run;
    writeFileSync(this.path + ".viewer.json", JSON.stringify({ onboarding_complete: true }));
    const view = await Viewer.create(this, 160, 40);
    await view.input("\x02A\x1b[C");
    await view.advance(0.3);
    await this.until(async () => (await view.poll()).data.includes("Manage agents"));
    await view.input("/add claude\t");
    const before = screen_text((await view.poll()).data, 160, 40),
      row = before.findIndex(row => /›\s+\+ New Claude Code account/.test(row)),
      col = before[row].indexOf("Claude Code");
    // Clicking into sign-in must release the manager's mouse-down state too.
    await view.input(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`);
    await this.until(async () => (await view.poll()).data.includes("Select login method"));
    await view.input("\r");
    const rows = await this.until(async () => {
      const rows = screen_text((await view.poll()).data, 160, 40);
      return rows.some(row => row.includes("Paste code here")) ? rows : null;
    });
    const y = rows.findIndex(row => row.includes("https://claude.com")) + 1;
    const x = 8;
    await view.input(`\x1b[<35;${x + 1};${y + 1}M`); // The wrapped continuation.
    this.assertIn("Copy link", screen_text((await view.advance(0.15)).data, 160, 40).join("\n"));
    await view.input(`\x1b[<35;${x + 3};${y + 3}M\x1b[<0;${x + 3};${y + 3}M`);
    const copied = await view.input(`\x1b[<0;${x + 3};${y + 3}m`);
    this.assertEqual(copied.effects, [
      { write_terminal: `\x1b]52;c;${Buffer.from(signin_url).toString("base64")}\x07` },
    ]);
    this.assertIn("Copied", screen_text(copied.data, 160, 40).join("\n"));
    await view.input("\x03");
    const closed = await this.until(async () => {
      const state = await view.poll();
      return state.data.includes("Manage agents") ? state : null;
    });
    this.assertNotIn("Copy link", closed.data);
    this.assertNotIn("Copied", closed.data);
    this.assertEqual(this.listed(), []);
  }
  async test_cancelling_signin_returns_to_the_filtered_manager() {
    this.env.CORGI_CLAUDE_BIN = this.first_run;
    writeFileSync(this.path + ".viewer.json", JSON.stringify({ onboarding_complete: true }));
    const view = await Viewer.create(this, 160, 40);
    await view.input("\x02A");
    await view.input("\x1b[C");
    await view.advance(0.3);
    await this.until(async () => (await view.poll()).data.includes("Manage agents"));
    await view.input("/add claude\t");
    // Add agent shows its accounts' readings; compare once they've arrived.
    const before = await this.until(async () => {
      const rows = screen_text((await view.poll()).data, 160, 40);
      return rows.some(row => row.includes("Reading…")) ? null : rows;
    });
    this.assertTrue(
      before.some(row => /›\s+\+ New Claude Code account/.test(row)),
      before.join("\n"),
    );
    // The card, including its query and selected Add row, comes back intact.
    const card = (rows: string[]) => {
      const top = rows.findIndex(row => row.includes("Manage agents") && row.includes("╭")),
        bottom = rows.findIndex((row, i) => i > top && row.includes("╰")),
        left = rows[top].indexOf("╭"),
        right = rows[top].indexOf("╮") + 1;
      return rows.slice(top, bottom + 1).map(row => row.slice(left, right));
    };
    for (const cancel of ["\x03", "\x1b[99;5u", "\x11"]) {
      await view.input("\r");
      await this.until(async () => (await view.poll()).data.includes("Select login method"));
      const dir = join(this.env.XDG_STATE_HOME!, "corgi", "accounts", "claude", "1"),
        temp = readlinkSync(dir);
      await view.input(cancel);
      const after = await this.until(async () => {
        const state = await view.poll();
        this.assertFalse(state.detached);
        return state.data.includes("Manage agents") ? screen_text(state.data, 160, 40) : null;
      });
      this.assertEqual(card(after), card(before));
      this.assertEqual(this.listed(), []);
      this.assertFalse(this.lstat(dir));
      this.assertFalse(existsSync(temp));
    }
  }
  async test_settings_shares_account_deletion_and_command_editing_with_the_launcher() {
    // This path reads provider metadata; the ordinary interactive fixture does not implement it.
    writeExecutable(
      this.env.CORGI_CLAUDE_BIN!,
      `await import(${JSON.stringify(join(ROOT, "tests/claude_metadata.ts"))});`,
    );
    for (const [dir, email] of [
      [this.env.CLAUDE_CONFIG_DIR!, "me@home.com"],
      [this.work, "me@work.com"],
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "metadata.json"), JSON.stringify({ email }));
    }
    const view = await Viewer.create(this, 160, 40),
      rows = async () => screen_text((await view.poll()).data, 160, 40),
      click = (x: number, y: number) => view.input(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    await view.input("\x02i");
    const settings = await rows(),
      y = settings.findIndex(row => row.includes("Manage agents"));
    this.assertGreaterEqual(y, 0);
    await click(settings[y].indexOf("Manage agents"), y);
    await view.input("\r");
    await this.until(async () => (await rows()).some(row => row.includes("me@work.com")));
    await view.input("/work\t\x7f");
    await view.advance(0.4);
    for (let i = 0; i < 30; i++) {
      await view.input("\x7f");
      await view.advance(0.05);
    }
    await view.advance(2);
    await this.until(async () => !(await rows()).some(row => row.includes("me@work.com")));
    this.assertTrue(existsSync(this.work));
    this.assertTrue(existsSync(join(this.work, "metadata.json")));
    // Left returns to settings' section list; re-entering retains the search.
    await view.input("\x1b[D\r\t" + "\x7f".repeat(4) + "custom\t\r");
    await view.input("\x1b[200~claude --model opus\x1b[201~");
    await this.until(async () => (await rows()).some(row => row.includes("[Show command]")));
    await view.input("\r");
    await this.until(async () =>
      (await this.session()).agent_commands.some((c: any) => c.original === "claude --model opus"),
    );
    this.assertTrue((await rows()).some(row => row.includes("Corgi setup")));
    await view.input("\x1b");
    await this.until(async () => !(await view.poll()).data.includes("Corgi setup"));
    await view.input("\x02A");
    this.assertFalse((await rows()).some(row => row.includes("me@work.com")));
    await view.input("\x1b[C");
    await view.advance(0.3);
    await this.until(async () => (await rows()).some(row => row.includes("claude --model opus")));
    // The account stays removed after reopening the manager.
    this.assertFalse((await rows()).some(row => row.includes("me@work.com")));
  }
  async test_account_deletion_keeps_drawing_while_logout_waits() {
    const dir = join(realpathSync(this.env.XDG_STATE_HOME!), "corgi", "accounts", "claude", "1"),
      started = join(this.temp.name, "logout-started"),
      release = join(this.temp.name, "logout-release");
    signIn(dir, "slow@example.com");
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ email: "slow@example.com" }));
    const identity = lstatSync(dir, { bigint: true });
    writeFileSync(
      join(this.env.XDG_STATE_HOME!, "corgi", "accounts.json"),
      JSON.stringify({
        accounts: [
          {
            provider: "claude",
            dir,
            name: "slow",
            managed: true,
            created: `${identity.dev}:${identity.ino}:${identity.birthtimeNs}`,
          },
        ],
      }),
    );
    writeExecutable(
      this.env.CORGI_CLAUDE_BIN!,
      `
      import { existsSync, writeFileSync } from "node:fs";
      if (process.argv[2] === "auth" && process.argv[3] === "logout") {
        writeFileSync(${JSON.stringify(started)}, "started");
        while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
        process.exit(0);
      }
      await import(${JSON.stringify(join(ROOT, "tests/claude_metadata.ts"))});
    `,
    );
    const view = await Viewer.create(this, 160, 40);
    let holding: Promise<void> | null = null;
    try {
      await view.input("\x02A\x1b[C");
      await view.advance(0.3);
      await this.until(async () => (await view.poll()).data.includes("slow"));
      await view.input("/slow\t");
      holding = (async () => {
        await view.input("\x7f");
        await view.advance(0.4);
        for (let i = 0; i < 30; i++) {
          await view.input("\x7f");
          await view.advance(0.05);
        }
      })();
      await deadline(holding, 5000, "Account logout blocked viewer input");
      await this.until(() => existsSync(started));
      const first = screen_text((await view.advance(2)).data, 160, 40).find(row => row.includes("Deleting..."));
      this.assertTrue(first);
      const second = screen_text((await view.advance(0.3)).data, 160, 40).find(row => row.includes("Deleting..."));
      this.assertTrue(second);
      this.assertFalse(first === second, "deletion progress must keep animating");
      this.assertTrue(existsSync(dir));
      // The pending deletion also leaves keyboard navigation responsive.
      await view.input("\tz");
      this.assertIn("slowz", (await view.poll()).data);
      await view.input("\x7f");
      writeFileSync(release, "go");
      await this.until(async () => {
        const state = await view.poll();
        return !existsSync(dir) && !state.data.includes("Deleting...");
      });
    } finally {
      writeFileSync(release, "go");
      await holding?.catch(() => {});
    }
  }
  lstat(path: string) {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  }
}
registerCase("accounts", Accounts, { timeout: 90_000 });
