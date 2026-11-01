import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "./runtime";
import { Viewer } from "./viewer_client";
import { EXE, registerCase, run } from "./support";
import * as terminal from "../src/pane/terminal";
import * as text from "../src/text";

class Languages extends Runtime {
  async configure() {
    delete this.env.CORGI_LANG;
    delete this.env.LC_ALL;
    delete this.env.LANGUAGE;
    this.env.LC_MESSAGES = "ja_JP.UTF-8";
    this.env.LANG = "en_US.UTF-8";
    writeFileSync(
      join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"),
      JSON.stringify({ onboarding_complete: true, language: "ru" }),
    );
  }
  async test_language_choice_updates_viewers_and_human_help_without_changing_machine_help() {
    const first = await Viewer.create(this, 112, 36),
      second = await Viewer.create(this, 112, 36);
    await first.action("setup");
    await second.action("setup");
    this.assertIn("Настройка Corgi", first.state.data);
    this.assertIn("Настройка Corgi", second.state.data);
    for (let i = 0; i < 4; i++) await first.input("\x1b[B");
    const screen = new terminal.Terminal(112, 36);
    let rows: string[];
    try {
      screen.feed(Buffer.from(first.state.data));
      rows = screen.text().split("\n");
    } finally {
      screen.destroy();
    }
    const y = rows.findIndex(row => row.includes("日本語"));
    this.assertTrue(y >= 0, "Language choices must show native names");
    const x = text.displayWidth(rows[y].slice(0, rows[y].indexOf("日本語")));
    await first.input(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    this.assertIn("Corgi設定", first.state.data);
    await this.until(async () => (await second.poll()).data.includes("Corgi設定"));
    this.assertEqual(
      JSON.parse(readFileSync(join(this.env.XDG_STATE_HOME!, "corgi/viewer.json"), "utf8")).language,
      "ja",
    );
    const human = await run([EXE, "--help", "--no-agent"], { env: this.env });
    this.assertIn("Ghosttyを使った小さなエージェント用端末", human.stdout);
    const machine = await run([EXE, "--help", "--agent"], { env: this.env });
    this.assertNotIn("Ghosttyを使った", machine.stdout);
    this.assertIn("corgi workspace new NAME", machine.stdout);
    this.env.CORGI_LANG = "ko_KR.UTF-8";
    const overridden = await Viewer.create(this, 112, 36);
    await overridden.action("setup");
    this.assertIn("Corgi 설정", overridden.state.data);
  }
}
registerCase("Languages", Languages);
