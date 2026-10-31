import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { screen_text } from "./runtime";
import { registerCase } from "./support";

class Keybindings extends Viewers {
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
