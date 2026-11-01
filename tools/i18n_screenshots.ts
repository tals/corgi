/** Capture localization screens in live Ghostty at wide and narrow sizes.
 * bun tools/i18n_screenshots.ts [en zh ja ko ru]
 * Requires the Ghostty capture dependencies and fonts covering the selected languages.
 * PNGs are saved at native resolution under dist/i18n-ghostty/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ghostty from "./ghostty_screenshot";
import * as locale from "../src/locale";

const root = path.resolve(import.meta.dir, "..");
const requested = process.argv.slice(2);
const languages = requested.length
  ? requested.map(value => {
      const language = locale.parse(value);
      if (!language) throw Error(`Unsupported language: ${value}`);
      return language;
    })
  : locale.locales;
for (const language of languages) {
  for (const cols of [112, 80]) {
    await ghostty.capture(
      { sandbox: "launcher", cols, rows: cols === 112 ? 36 : 26, wait: 30 },
      {
        async prepare(s) {
          s.env.CORGI_LANG = language;
          const fixture = path.join(s.dir, "repos/app/localization.ts");
          fs.writeFileSync(fixture, 'export const languages = ["English", "中文", "日本語", "한국어", "Русский"];\n');
        },
        async drive(d) {
          const s = d.sandbox!;
          const screenshot = (scene: string) =>
            d.screenshot(path.join(root, "dist/i18n-ghostty", `${language}-${cols}-${scene}.png`));
          const action = (name: string) => s.corgi(["action", name]);
          if (cols > 80) {
            action("review");
            await screenshot("review");
            action("review");
          }
          action("setup");
          await screenshot("settings");
          d.key("Down", "Down", "Down", "Down");
          await screenshot("language");
          d.key("Escape");
          action("help");
          await screenshot("shortcuts");
          d.key("Escape");
          action("new-agent");
          await screenshot("agents");
          d.key("Right");
          await screenshot("manage");
          d.key("Escape", "Escape");
          action("onboard");
          await screenshot("welcome");
        },
      },
    );
  }
}
