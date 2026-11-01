/** Each page carries only its own recorded screens. */
import { join } from "node:path";
import type { Locale } from "../src/locale";

export function frames(language: Locale): Bun.BunPlugin {
  return {
    name: "site-frames",
    setup(build) {
      build.onLoad({ filter: /\/site\/frames\.json$/ }, async () => ({
        contents: await Bun.file(
          join(import.meta.dir, language === "en" ? "frames.json" : `frames/${language}.json`),
        ).text(),
        loader: "json",
      }));
    },
  };
}
