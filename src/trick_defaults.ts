import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import accountColors from "../assets/account-colors.mjs.txt" with { type: "text" };

/** Seed editable code once; preserve custom files and deliberate removals. */
export function install(root: string) {
  const marker = join(root, ".defaults"),
    target = join(root, "account-colors");
  if (existsSync(marker)) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    const staging = mkdtempSync(join(root, ".defaults-"));
    try {
      writeFileSync(join(staging, "main.mjs"), accountColors, { mode: 0o600 });
      writeFileSync(join(staging, "trick.toml"), 'version = 1\nid = "account-colors"\nentry = "main.mjs"\n', {
        mode: 0o600,
      });
      try {
        renameSync(staging, target);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as { code: string }).code)) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  try {
    writeFileSync(marker, "1\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as { code: string }).code !== "EEXIST") throw error;
  }
}
