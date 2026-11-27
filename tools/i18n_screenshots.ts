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
          const shot = (scene: string) =>
            `shot "${path.join(root, "dist/i18n-ghostty", `${language}-${cols}-${scene}.png`)}"`;
          const print = (lines: string[]) => lines.forEach(line => console.log(line));
          if (cols > 80) print(await d.drive(`action review; ${shot("review")}; action review`));
          print(
            await d.drive(
              [
                `action setup; ${shot("settings")}`,
                `key down down; ${shot("language")}`,
                `key esc; action help; ${shot("shortcuts")}`,
                `key esc; action new-agent; ${shot("agents")}`,
                `key right; ${shot("manage")}`,
                `key esc esc; action onboard; ${shot("welcome")}`,
              ].join("; "),
            ),
          );
        },
      },
    );
  }
}
