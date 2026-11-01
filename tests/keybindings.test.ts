import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { screen_text } from "./runtime";
import { registerCase } from "./support";

class Keybindings extends Viewers {
  async test_last_navigation_keys_keep_history_per_viewer() {
    const first = await this.new(),
      second = await this.new(),
      third = await this.new(),
      home = (await this.session()).workspaces[0].id;
    const other = (await this.command("workspace.create", { name: "Other", cwd: this.temp.name })).workspace;
    const file = join(this.env.XDG_STATE_HOME!, "corgi", "viewer.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), preset: "tmux" }));
    const a = await this.newViewer(),
      b = await this.newViewer();
    const initial = a.state.pane;
    this.assertEqual((await a.input("\x02l")).pane, initial);
    this.assertIn("No previous tab", a.state.data);
    await a.focus(first);
    await a.focus(third);
    await b.focus(first);
    await b.focus(second);
    this.assertEqual((await a.input("\x02l")).pane, first);
    this.assertEqual((await a.input("\x02l")).pane, third);
    this.assertEqual((await b.input("\x02l")).pane, first);
    await a.request({ op: "workspace", workspace: other });
    this.assertEqual((await a.input("\x02L")).workspace, home);
    this.assertEqual((await a.action("last-tab")).pane, first);
    this.assertEqual((await a.input("\x02L")).workspace, other);
    this.assertEqual((await b.action("last-workspace")).workspace, home);
    this.assertIn("No previous workspace", b.state.data);
    this.assertEqual((await a.input("\x02L")).workspace, home);
    await this.command("workspace.close", { target: other, close_contents: true });
    await a.poll();
    this.assertEqual((await a.input("\x02L")).workspace, home);
    this.assertIn("No previous workspace", a.state.data);
  }

  async test_prefix_toggle_cancel_and_restore_defaults() {
    const first = await this.new(),
      second = await this.new();
    const viewer = await this.newViewer(80, 24);
    await viewer.action("keybindings");
    await viewer.input("/Next tab\r\r\x1b[A ");
    this.assertIn("[ ] Use prefix", screen_text(viewer.state.data, 80, 24).join("\n"));
    await viewer.input("\x1b[27u\r");
    this.assertIn("[x] Use prefix", screen_text(viewer.state.data, 80, 24).join("\n"));
    await viewer.input("\x1b[A \t\t\t\t\r");
    const file = join(this.env.XDG_STATE_HOME!, "corgi", "viewer.json");
    this.assertEqual(JSON.parse(readFileSync(file, "utf8")).keys.next, ["n"]);
    await viewer.input("\x1b[27u\x1b[27u\x1b[27u");
    await viewer.focus(first);
    this.assertEqual((await viewer.input("n")).pane, second);

    await viewer.action("keybindings");
    await viewer.input("/Next tab\r\r");
    this.assertIn("Use defaults", screen_text(viewer.state.data, 80, 24).join("\n"));
    await viewer.input("\t\r");
    this.assertEqual(JSON.parse(readFileSync(file, "utf8")).keys.next, ["n"]);
    await viewer.input("\r");
    this.assertEqual(JSON.parse(readFileSync(file, "utf8")).keys?.next, undefined);
    await viewer.input("\x1b[27u\x1b[27u\x1b[27u");
    await viewer.focus(first);
    this.assertEqual((await viewer.input("\x02n")).pane, second);
  }

  async test_editor_persists_alternates_and_live_reload_keeps_last_valid_keys() {
    const first = await this.new(),
      second = await this.new();
    const a = await this.newViewer(148, 48),
      b = await this.newViewer();
    await a.action("keybindings");
    await a.input("/Next tab\r\r\r");
    this.assertIn("Press a shortcut", screen_text(a.state.data, 148, 48).join("\n"));
    await a.input("y\r");
    const file = join(this.env.XDG_STATE_HOME!, "corgi", "viewer.json");
    let saved = JSON.parse(readFileSync(file, "utf8"));
    this.assertEqual(saved.keys.next, ["prefix+y"]);
    await a.input("\x1b[27u\x1b[27u\x1b[27u");
    await a.focus(first);
    this.assertEqual((await a.input("\x02y")).pane, second);
    await this.until(async () => {
      await b.focus(first);
      return (await b.input("\x02y")).pane === second;
    });
    const replacement = { ...saved, keys: { ...saved.keys, tab: { keys: ["prefix+é", "prefix+f12"] } } };
    writeFileSync(file + ".tmp", JSON.stringify(replacement));
    renameSync(file + ".tmp", file);
    await this.until(async () => {
      await a.focus(second);
      return (await a.input("\x02é")).pane === first;
    });
    this.assertEqual((await a.input("\x02\x1b[24~")).pane, second);
    writeFileSync(file, '{"keys":');
    await this.until(async () =>
      screen_text((await a.poll()).data, 148, 48)
        .join("\n")
        .includes("keeping the working shortcuts"),
    );
    this.assertEqual((await a.input("\x02é")).pane, first);
    writeFileSync(file, JSON.stringify(replacement));
    const reopened = await this.newViewer();
    await reopened.focus(second);
    this.assertEqual((await reopened.input("\x02é")).pane, first);
    saved = JSON.parse(readFileSync(file, "utf8"));
    this.assertEqual(saved.keys.tab, { keys: ["prefix+é", "prefix+f12"] });
  }
}
registerCase("Keybindings", Keybindings, { inherited: false });
