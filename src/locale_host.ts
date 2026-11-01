//! Host-only fallback for macOS terminals that supply no message locale.
import * as locale from "./locale";
import * as i18n from "./i18n";
let appleLanguages: string[] | undefined;

export function detect(preference?: locale.Locale): locale.Locale {
  const env = process.env;
  const override = env.CORGI_LANG?.trim();
  const specified = override && override.toLowerCase() !== "auto";
  const preferred = env.LANGUAGE?.split(":").some(language => locale.parse(language) !== null);
  if (
    process.platform !== "darwin" ||
    specified ||
    preference ||
    preferred ||
    env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANG
  )
    return locale.detect(env, preference);
  if (appleLanguages === undefined) {
    appleLanguages = [];
    try {
      const result = Bun.spawnSync(["/usr/bin/defaults", "read", "-g", "AppleLanguages"], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: 1000,
      });
      if (result.exitCode === 0)
        appleLanguages = result.stdout.toString().match(/[a-zA-Z]+(?:[-_][a-zA-Z0-9]+)*/g) ?? [];
    } catch {
      // Locale discovery is best effort.
    }
  }
  return locale.detect(env, preference, appleLanguages);
}
export function initialize(preference?: locale.Locale): void {
  i18n.setLanguage(detect(preference));
}
